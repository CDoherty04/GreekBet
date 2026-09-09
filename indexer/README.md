# GreekBet indexer — listen & parse

Watches the GreekBet Anchor program, decodes its events, and emits a
deduplicated, slot-ordered stream.

**Persistence is deliberately out of scope.** The product of this package is a
stream of parsed events; a separate process consumes it and writes to a
database. That boundary is [`OutputAdapter`](src/output/adapter.ts) and nothing
upstream of it knows where events end up.

```sh
yarn install
yarn test          # 26 tests, no network required
yarn start         # devnet, ./data/events.jsonl, ./data/checkpoint.json
```

```sh
greekbet-indexer --endpoint https://api.devnet.solana.com \
                 --out ./data/events.jsonl \
                 --checkpoint ./data/checkpoint.json
```

## What comes out

One JSON object per line. `event_type`, `market`, `slot`, `signature`,
`event_index`, `block_time`, `data` — the shape the plan specified, since a
separate consumer is being written against it.

```json
{
  "event_type": "MarketCreated",
  "market": "8n7XdRHay1q3ioM68K4oPY38c9p8AZ47hvcLLYAEwMX5",
  "slot": 495724918,
  "signature": "2TLvcwx2PAAcmyFgsorHwwx88CpPYsirieuxfUZngvWD8vNEWyXL4ByGJidWyPaBBSPW8K251YQ5vG9pWN84CufE",
  "event_index": 0,
  "block_time": 1788973358,
  "data": { "creator": "BHBo…", "b": "100000000", "seed_amount": "69314718", "…": "…" }
}
```

**Every `u64` is a decimal string, never a JSON number.** Share quantities reach
`1e15` and a `u64` is not bounded by the program's current limits; a JSON number
would silently lose precision at the top of the range with no error anywhere.
Slots and timestamps stay numbers — they are small, and ordering by a string
would be actively unhelpful.

## Event names differ from the original plan

The plan assumed a single `SharesTraded { is_buy }` and a `SharesRedeemed`. The
deployed program instead emits **`SharesBought`** and **`SharesSold`** as
distinct events, and calls redemption **`Redeemed`**.

The program is live and its keypair exists on one machine, so renaming events on
chain would mean a redeploy for cosmetics. The indexer carries the difference
instead — the cheaper and more reversible side to put it on. Both trade events
normalize onto one shape with `is_buy` recovering the plan's unified view, and
the trader is `user` on both rather than `buyer`/`seller`, so a consumer never
branches on event type to find who traded.

| plan | program | on the wire |
|---|---|---|
| `SharesTraded` | `SharesBought` / `SharesSold` | both, with `is_buy` |
| `SharesRedeemed` | `Redeemed` | `Redeemed` |
| `MarketCreated` / `MarketClosed` / `MarketResolved` | same | same |

## The IDL is bundled, not fetched

[`idl/greekbet.json`](idl/greekbet.json) is committed and loaded from disk.

This is not a preference. Anchor 1.2's deploy also uploads the IDL to an
on-chain metadata account, and for this program that upload failed partway — it
is why `anchor deploy` exited 1 *after* successfully deploying. `anchor idl
fetch` returns raw zlib and the document is incomplete, so runtime fetching
would decode nothing.

Bundling is better regardless: no RPC round-trip at startup, and decoding is
pinned to a known IDL rather than whatever is on chain, which can drift from the
deployed binary. Re-copy it after any program change:

```sh
cp ../contracts/target/idl/greekbet.json idl/greekbet.json
```

## How it stays exactly-once

Three mechanisms, each doing one job:

**Checkpoint** ([`checkpoint.ts`](src/checkpoint.ts)) — a plain JSON file holding
the last processed slot *and every signature already emitted at that slot*. A
slot can hold several transactions and a crash can land mid-slot; resuming from
`slot + 1` would skip the rest of it, and from `slot` alone would re-emit all of
it. Storing the boundary signatures means the slot is replayed but nothing is
re-emitted. The set is one slot wide, which is what makes a plain file sound
here. Written temp-then-`rename` so a crash never leaves a partial file, and a
corrupt one is refused rather than silently discarded — ignoring it would
re-index from genesis.

**Deduplicator** ([`dedup.ts`](src/dedup.ts)) — keys on `(signature,
event_index)`, not signature alone. One transaction can emit several events, so
keying on the signature would drop every event after the first in any
multi-instruction transaction. The window is bounded and evicts oldest-first;
`evictions` is exposed because a non-zero value means the window is narrower
than the replay overlap and duplicates could get through.

**Ordering** — the subscription starts *before* the backfill and buffers what
arrives. Subscribing after would leave a hole between "backfill read its last
page" and "subscription active". Overlapping the two windows and letting dedup
absorb the overlap is what closes it.

Output is emitted **before** the checkpoint advances. If the process dies
between the two, the batch is replayed and suppressed. The reverse order would
lose events outright — always prefer replay over loss.

## Verified against live devnet

Run against `api.devnet.solana.com` over the deployed program's real history:

```
backfill complete { signatures: 22, processed: 22 }
stopped { emitted: 20, duplicatesSuppressed: 0, backfills: 1, decodeSkips: 0 }

MarketCreated 2 · SharesBought 6 · SharesSold 2 · MarketClosed 2
MarketResolved 2 · Redeemed 6      unparseable lines: 0
```

Restarting against the same checkpoint emitted **0** new events, and 429s were
hit and absorbed during the run — the rate limiting below is not theoretical.

## Rate limits are a correctness concern

Measured against this program: **429s in bursts of 4–8**, a *confirmed*
signature 404ing from `getTransaction` for seconds, and 600–2,000 ms latency
against 40–500 ms locally.

So [`rpc.ts`](src/rpc.ts) retries with exponential backoff and **full jitter** —
without jitter, concurrent retries resynchronise and collide on every subsequent
attempt. Retries are an allowlist of transient conditions, not blanket: retrying
a malformed request or a bad program id would just hide a real defect behind a
delay.

`ChainSource` is an interface, so swapping raw RPC for Helius or a self-hosted
node is one class and touches nothing else.

## Testing

`yarn test` runs 26 tests with **no network**.

Decoder tests run against **real captured devnet logs**
([`test/fixtures/devnet-lifecycle.json`](test/fixtures)) — the actual
transactions from the deployed program's lifecycle run, not hand-written
strings. That distinction matters: invented fixtures only prove the decoder
agrees with whoever invented them, while these carry the real borsh layouts,
real discriminators, and real interleaved noise from the SPL Token and System
programs. Regenerate with `npx ts-node scripts/capture-fixtures.ts`.

Two real bugs were caught this way and are now regression-tested:

- **`parseLogs` is a generator**, so it throws during *iteration*, not when
  called. Guarding only the call caught nothing, and one malformed log line from
  an unrelated program would have crashed the indexer.
- Events decoded **before** a malformed line in the same transaction must
  survive it. Abandoning the whole transaction would silently discard real
  trades.

## Not done yet

- **Account-state reconciliation** (plan §1.2). Events are the primary source
  and are sufficient for correctness today; periodic `Market`/`UserPosition`
  snapshots to detect drift are not built.
- **A queue adapter** (plan §4 Option B). The interface is proven by two
  implementations — file and in-memory — but no Redis/NATS adapter exists.
- **Devnet soak test** (plan §6). Verified over the program's full history and a
  restart, not over an extended live run.

One thing worth knowing before building the consumer: `price_yes_after` exists
**only** in the trade events. The `Market` account stores `q_yes`/`q_no` but not
price, so anything reconstructing a price history has to use events —
account snapshots alone cannot produce it.
