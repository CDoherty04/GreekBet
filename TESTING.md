# Testing this yourself

Everything runs against **Solana devnet**. No real funds are involved.

## One-time setup

```bash
npm install
```

`.env.local` is already written and points at devnet, the deployed program, and
a 6-decimal test mint. Nothing to edit.

> **Why a test mint and not real USDC?** Circle's devnet USDC faucet is
> reCAPTCHA-gated, so no script can obtain it. The test mint's authority belongs
> to the deploy wallet, so `npm run fund` can top up any wallet on demand. The
> program stores the mint per market and only requires 6 decimals, so it behaves
> identically. Point `NEXT_PUBLIC_COLLATERAL_MINT` at
> `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` if you have real devnet USDC.

## The fastest check — no browser

Confirms the whole chain layer works: create a market, quote a trade, buy, sell.

```bash
npm run smoke
```

It prints the wallet it uses. If that wallet is unfunded it tells you, and:

```bash
npm run fund -- <address-it-printed>
```

A pass looks like this, and the important line is the last one — the quote and
the executed trade agree exactly, which is the property the whole quoting design
exists to guarantee:

```
[2] quote 1.00 USDC of YES (simulated against the program)
    would receive 1.90 YES shares
[3] buy_shares
    received 1.90 YES
    quote matched the executed trade exactly
```

## The full app

**Two terminals.** The app reads market state from the indexer's event stream,
so without the indexer running every market shows as "Confirming on chain…".

**Terminal 1 — the indexer:**

```bash
npm run indexer
```

Leave it running. The first pass backfills the program's whole history (~20
events, a few seconds), then it streams. Expect occasional `rpc retry` warnings
about 429s — devnet rate-limits aggressively and the retry layer absorbs it.

**Terminal 2 — the app:**

```bash
npm run dev
```

Open http://localhost:3000 on a phone-sized viewport (the UI is mobile-first).

### Walk through it

1. **Sign up** at `/onboarding` — any name and phone, plus a selfie. A Solana
   wallet is provisioned automatically.
2. **Fund it.** The balance pill in the header will read `$0.00` and warn
   `no SOL`. Get the address from `.data/keypairs.json`, or just run the smoke
   test which prints one, then:
   ```bash
   npm run fund -- <your-address>
   ```
   The pill updates within ~15 seconds.
3. **Join the demo group** with code `DEMO24`, or create your own.
4. **Create a market.** This is a real transaction and takes a few seconds. It
   costs **~6.93 of collateral** — the LMSR subsidy `b·ln2`, which the creator
   puts at risk to make the market. It will show as "Confirming on chain…" until
   the indexer sees it.
5. **Trade.** Pick YES or NO, buy or sell, type an amount. The quote appears
   after a moment — it is a live simulation against the program, so the shares
   shown are the shares you will get.
6. **Sell back.** This is the part parimutuel betting could not do: your
   position is shares in a market maker, so you can exit before resolution at
   the prevailing price.
7. **Resolve.** Only possible once the close time has passed. Upload a photo;
   the AI decides, and the outcome is written on chain by the resolver
   authority.
8. **Redeem.** Winners claim 1:1 from the vault. Losers get zero but still close
   out and reclaim their account rent.

## What to look for

- **The odds move as you trade**, along a bonding curve — buying YES raises the
  YES price for the next buyer. That is the market maker, not a pool ratio.
- **Every trade appears in the trade list** with the trader's name, sourced from
  the indexer rather than from app state.
- **The vault figure** is real collateral held by a program-owned account.
- Look up any market on
  [Solana Explorer](https://explorer.solana.com/?cluster=devnet) — the address
  in the URL is the on-chain PDA.

## When something looks wrong

| symptom | cause |
|---|---|
| Market stuck on "Confirming on chain…" | the indexer is not running, or has not caught up |
| `This wallet has no devnet SOL for fees` | run `npm run fund` |
| `Not enough USDC to seed this market's liquidity` | creating a market costs ~6.93; `npm run fund` mints 100 |
| Trade fails with `SlippageExceeded` | someone traded between your quote and your submit; retry |
| `rpc retry` spam in the indexer | normal devnet rate limiting |
| Odds look stale | the projection follows the indexer; give it a few seconds |

## Running the other suites

```bash
cd contracts && anchor build --arch v0 && anchor test --skip-build --validator legacy   # 44 on-chain tests
cd contracts && cargo test --workspace                                                   # 124 Rust tests
cd indexer   && yarn test                                                                # 26 tests, no network
```
