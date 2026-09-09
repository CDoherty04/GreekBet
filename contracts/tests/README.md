# `tests/` — the T09 local-validator suite

44 tests against a real `solana-test-validator`, covering the full market
lifecycle, exact parity with the Python oracle, every negative path with its
own error code, and multi-user solvency.

The program is **not** modified by anything in here. T09 owns `tests/`,
`package.json`, `tsconfig.json`, and the `[scripts]` section of `Anchor.toml`,
and nothing else. Findings against `programs/` are reported, not fixed.

---

## Running it

```sh
# WSL only. See docs/TOOLCHAIN.md; native Windows Anchor builds are not supported.
. "$HOME/.greekbet-env.sh"
cd <workspace>

anchor build --arch v0
anchor test --skip-build --validator legacy
```

**Both flags are mandatory and neither is a style choice.**

- `--arch v0` — Anchor 1.2.0 defaults to sbpf v3, which Agave 3.1.10 cannot
  load (`invalid file header` on deploy, `Unsupported program id` at the
  validator). `anchor test` has no `--arch` of its own and `anchor test --
  --arch v0` errors with "provided more than once", so the arch has to be set
  by a separate build and `anchor test` then needs `--skip-build`.
- `--validator legacy` — selects `solana-test-validator`. Anchor 1.2's default
  is `surfpool`, which is not installed and should not be.

**A stale v0 `.so` in `$CARGO_TARGET_DIR/deploy/` will make a broken build look
like a pass.** If a result surprises you:

```sh
rm -f "$CARGO_TARGET_DIR"/deploy/greekbet.so
rm -rf "$CARGO_TARGET_DIR"/sbpf-solana-solana "$CARGO_TARGET_DIR"/sbpfv3-solana-solana
anchor build --arch v0
```

Do **not** delete `$CARGO_TARGET_DIR/deploy/greekbet-keypair.json` — that is the
program id, it is gitignored, and it lives outside the repo.

### One file at a time

```sh
GB_TESTS='tests/negative.ts' anchor test --skip-build --validator legacy
```

### Fresh checkout

```sh
yarn install
ln -sfn "$CARGO_TARGET_DIR" ./target    # `../target/types/greekbet` resolves through this
```

`node` and `yarn` must be the **WSL** installs (`~/.nvm/.../v24.20.0`, yarn
1.22.22). Windows `npm` leaks onto `PATH` via WSL interop with no matching
`node`; sourcing `~/.greekbet-env.sh` puts the Linux one first. If
`command -v node` starts with `/mnt/c/`, the environment was not sourced.

---

## What each file covers

| File | Tests | Covers |
|---|---:|---|
| `utils.ts` | — | Shared fixtures. Not a spec (`--ignore`d); see below. |
| `lifecycle.ts` | 9 | create → buy ×3 → sell → close → resolve → redeem, in order, with vault solvency after every step. |
| `parity.ts` | 10 | Replays `reference/vectors/trades.json` on chain and demands **exact** equality. |
| `negative.ts` | 23 | Every failure path, each asserting its **specific** error code. |
| `concurrency.ts` | 2 | 5 users, 19 interleaved trades, both resolutions; solvency and obligation cover after every instruction. |

### `utils.ts`

Hermetic by construction (`docs/DESIGN_DECISIONS.md` D3): the suite creates its
own 6-decimal SPL mint and mints freely. No faucet is involved in collateral.
SOL for rent and fees comes from the validator's airdrop, which is a property
of the validator rather than of the collateral model.

Three helpers exist because of specific properties of the program:

- **`deriveMarket`** — the market PDA cannot be auto-derived. Anchor's IDL has
  no vocabulary for a hashed seed, so `create_market`'s `market` account
  carries no `pda` metadata (`create_market.rs` explains why in detail). The
  seed is `sha256` over the **raw UTF-8 question bytes** — no normalisation, no
  length prefix, no lowercasing. Vault and position keep their metadata; the
  suite still passes every account explicitly so a resolver change cannot
  silently alter what is under test.
- **`rpcWithEvents`** — `Market` stores `q_yes`/`q_no` but **no price**, so the
  marginal price is only observable through the `SharesBought`/`SharesSold`
  events. Exact price parity therefore needs event decoding, which this does
  (and it captures the instruction's compute usage on the way past).
- **`waitForOnChainTime`** — there is no clock warp on `solana-test-validator`,
  so `close_time` is real wall-clock time. This polls the `Clock` sysvar — the
  exact value the program compares against — rather than sleeping against the
  host clock, which can drift from it.

`ERR` mirrors `GreekBetError`'s discriminants, and `assertIdlErrorCodesMatch`
re-checks the whole table against the freshly built IDL at the start of two
files, so a silent renumbering cannot make a negative test pass for the wrong
reason.

### `lifecycle.ts`

Ordered, state-sharing tests; mocha runs them in declaration order and each one
builds on what the last left behind. That is deliberate — the exit criterion is
about a lifecycle, not six independent instructions.

Asserted: the vault holds exactly `floor(b·ln2)` at creation (69,314,718 base
units at `b` = 100 USDC); shares credited equal the `q` delta equal the
position delta; the vault rises by exactly the collateral paid and falls by
exactly the proceeds returned; winners redeem 1:1; the loser is paid zero, has
their position cleared, and gets their rent back; every position account is
gone afterwards.

**Price monotonicity is asserted precisely rather than loosely.** A YES buy
raises `price_yes` and a NO buy lowers it, so "price rises monotonically across
the three trades" is only true of the YES-buy subsequence — the NO buy in the
middle necessarily dips. The file asserts both halves plus the net effect
(price after trade 3 > price after trade 1).

### `parity.ts`

The strongest test here. Per replayed step it demands byte-exact equality on:
share count, collateral moved, `q_yes`/`q_no` (from both the event and the
account), `price_yes_after`, and the running vault balance against the oracle's
`net_collateral_after`. Zero tolerance, nowhere.

**Coverage is limited by the program's instruction surface, not by the test.**
`trades.json` has 503 steps in three op kinds — 262 `buy`, 123 `sell`, 118
`buy_with_collateral` — and only two of them map onto an instruction:

| vector `op` | instruction |
|---|---|
| `buy_with_collateral` | `buy_shares(outcome, usdc_amount, min_shares_out)` |
| `sell` | `sell_shares(outcome, share_amount, min_usdc_out)` |
| `buy` | **none — there is no share-denominated buy** |

A `buy` step names an exact share count. `buy_shares` is collateral-denominated
on purpose (`buy_cost(shares_for_cost(c))` overshoots `c` by one base unit
about once in 10,000 — `crates/lmsr/tests/README.md` §11 — and charging the
caller's own integer sidesteps it), so there is no way to express such a step,
and no way to steer a market onto its intermediate states either, since `q` is
only reachable through the collateral quote. Six further sequences
(`skewed_start`) begin at a non-zero `q`, which an on-chain market never does.

That leaves exactly **7 sequences / 61 steps**: the six `collateral_ladder`
sequences (one per `b` decade, `B_MIN` through `B_MAX`) and `random_walk_1` at
`b` = 10 USDC, the one that mixes buys and sells. The filter is computed from
the file rather than hardcoded, and the resulting id list, step count, `b`
coverage and skip reasons are all asserted, so coverage cannot shrink
unnoticed. The other 41 are not untested: `crates/lmsr/tests/` replays all 48
(503 steps) against the same crate this program calls.

### `negative.ts`

`expectError` fails if the call succeeds **or** if it fails with any code other
than the one named. Two results are worth knowing before reading it:

- **A second `redeem` fails with `AccountNotInitialized` (3012), not
  `NothingToRedeem` (6017).** `redeem` carries `close = owner`, so by the
  second call the position account is gone and deserialisation fails before the
  handler runs. `NothingToRedeem` is separately reachable and separately
  tested — through a trader who sold their entire holding before resolution,
  leaving a position that exists and holds 0/0. (`sell_shares` deliberately
  does **not** close an emptied position; only `redeem` does.)
- **A market past `close_time` reports `MarketNotOpen`, not
  `CloseTimeNotReached`.** `close_market` is a bookkeeping crank, not the
  trading boundary — `buy_shares` and `sell_shares` check the clock themselves,
  so trading stops at `close_time` whether or not anyone cranked.
  `CloseTimeNotReached` means the opposite: a crank that arrived too early.

Both slippage tests snapshot `q`, the vault, the wallet and the position and
assert the failure left every one of them untouched.

### `concurrency.ts`

Three invariants after **every** instruction: exact vault bookkeeping
(`seed + Σin − Σout`), obligation cover (`vault ≥ max(q_yes, q_no)`, since
resolution has not happened and either side may win), and
`Σ positions == q` on each side — without which "the vault covers `q`" would
say nothing about what holders can claim.

The script is fixed rather than random: a random walk that fails is not
reproducible, and the interesting structure (users crossing each other, one
unwinding while another accumulates, a late reversal of the majority side, a
trader who ends at 0/0 with a live account) is easier to design than to sample.
Both resolutions are run, on separate markets, because the binding obligation
is the *winning* side's and the two are different numbers.

There is no transaction-level concurrency. Solana serialises writes to `Market`
anyway, so two trades in one slot are two ordered state transitions; sending
them in parallel would exercise the RPC client's retry logic, not the program.
What is interleaved is the users.

---

## The residual, and what "rounding dust" actually means

The ticket asks for the vault to be "fully drained (± dust from documented
rounding) after all redemptions". **It is not, and it should not be.** After
every winner redeems, the vault holds `C(q) − q_win`: the market maker's
*unspent LMSR subsidy*, which goes to zero only in the limit where the market
resolved at absolute certainty. On the lifecycle market that is 52,912,657 base
units against a 69,314,718 seed — 76% of the subsidy unspent, because the
market resolved at a price well short of 1.

The part rounding actually controls is `vault − C(q)`, and that is only
measurable where `C(q)` is known — i.e. against the oracle. `parity.ts` does
exactly that decomposition on a replayed ladder:

```
vault before redemption = 332,931,471
oracle C(q) cost_after  = 332,931,468
payout (q_yes, 1:1)     = 332,931,446
RESIDUAL                =          25
  unspent subsidy       =          22   (= C(q) - q_win, exact)
  ROUNDING DUST         =           3   (= vault - C(q), over 8 steps)
  oracle margin_exact   =           3.2098...
```

**3 base units — 0.000003 USDC — over 8 trades, all of it in the protocol's
favour.** That matches the documented policy (`reference/README.md`, "ROUNDING
POLICY": money never rounds in the user's favour). Two exact bounds are
asserted at every step rather than a tolerance:

- `0 ≤ surplus` — the vault never falls below the exact cost function;
- `surplus ∈ {floor(margin_exact), floor(margin_exact) + 1}` — the integer
  surplus is within one base unit of the oracle's real-valued
  `solvency_margin_exact`. It cannot be pinned tighter than that, and the
  reason is arithmetic rather than implementation error: the two differ by
  `frac(C(q)) − frac(C(0,0))`, which lies strictly in `(−1, 1)`, so an integer
  can only land on one of two values. The first version of this assertion
  demanded `surplus == floor(margin)` and failed on 4 of 7 sequences for
  exactly that reason.

Also asserted: the surplus never exceeds one base unit per step elapsed.

---

## Compute units

`lifecycle.ts` scrapes the program's own `consumed N of M` log line and prints
a table; it also asserts every instruction stays under the 200,000 CU default,
since nothing in the suite raises the budget. Measured on the local validator:

| instruction | CU | % of 200,000 |
|---|---:|---:|
| `create_market` | 39,074 | 19.5% |
| `buy_shares` (first buy, `init_if_needed` on the position) | 54,465 | 27.2% |
| `sell_shares` | 61,107 | 30.6% |
| `close_market` | 4,762 | 2.4% |
| `resolve_market` | 5,185 | 2.6% |
| `redeem` (winner, transfers) | 13,939 | 7.0% |
| `redeem` (loser, no transfer) | 7,549 | 3.8% |

These are **whole-instruction** figures — Anchor account deserialisation, the
token CPI and the event, not just the LMSR maths that
`crates/lmsr/tests/compute_budget.rs` bounds. Two things are worth noticing
against T04's model, which predicted 60,587 CU for `buy_shares`'s maths alone
and 38,045 for `sell_shares`':

- the real `buy_shares` costs **less in total** than T04 budgeted for its
  arithmetic, so the 100,000 CU ceiling has more headroom than modelled;
- the ordering is **inverted** — `sell_shares` is the more expensive of the
  two on chain, despite `sell_return` being the cheaper LMSR call, because it
  signs a PDA withdrawal.

A warm `buy_shares` (one where the position account already exists) is not
measured here; every buy in `lifecycle.ts` is a first buy for its wallet.

---

## Setup notes that will otherwise cost an hour

### Node 24 strips types itself, and mocha 9 prefers `import()`

The `[scripts] test` line carries `NODE_OPTIONS=--no-experimental-strip-types`.
Without it the suite transpiles under **whichever loader happens to win**:
mocha 9 tries dynamic `import()` before `require()`, node 24 strips TypeScript
types natively, and node's strip-only mode rejects ordinary TypeScript
(parameter properties, enums) with a bare `SyntaxError` naming no file you
wrote. Whether a given spec took the ESM path depended on whether *every* one
of its imports resolved as ESM — an extensionless `./utils` fails, a bare
package specifier does not — which is not a property anyone should have to
reason about. The flag forces the `require()` path, so **ts-node** does the
work, deterministically.

`--ignore tests/utils.ts` keeps the fixture module out of the spec list. It has
no `describe`, so loading it as a test file only creates a way for it to fail.

### The provider is pinned to `confirmed`

`AnchorProvider.env()` defaults to `processed`, under which an account read
immediately after `rpc()` can legitimately return the *old* state. Every
assertion here is "send, then read", so the default would make the suite
intermittently and inexplicably wrong. `getProvider()` builds its own provider
at `confirmed` instead and calls `anchor.setProvider`.

### Time

`close_time` is real seconds. Markets that need to close use 20–75 s windows
and the suite genuinely waits, polling the `Clock` sysvar. `concurrency.ts`
creates its wallets **before** its market so the window starts after the slow
setup rather than during it.

---

## Known-flaky notes

Nothing observed flaking across runs, but the following are the places it
could:

- **Wall-clock windows.** `concurrency.ts` allows 75 s for 19 interleaved
  trades plus five wallet setups, measured at ~35 s on this machine; a much
  slower validator would trip `MarketNotOpen` mid-script. Raise
  `closeTimeSecondsFromNow` rather than reducing the assertions.
- **`getTransaction` lag.** Event decoding needs the transaction to be
  retrievable at `confirmed`; `rpcWithEvents` retries for ~5 s before failing
  with an explicit message rather than a confusing `undefined` event.
- **Airdrops.** Requested in 100-SOL chunks because the validator faucet caps a
  single request. A validator started without a faucet would fail in `before`.
- **Total runtime** is about 5–6 minutes, dominated by the `close_time` waits
  (roughly 2 minutes of it) and by 61 parity transactions.

---

## What this suite does not cover

- **Devnet.** That is T10 — real USDC, real ATAs, real fees.
- **`VaultInsolvent` (6015).** Structurally unreachable: LMSR bounds the
  maker's loss at `b·ln2`, `create_market` deposits it up front, and
  `C(q) ≥ max(q_yes, q_no)` in every state. The guard exists so an accounting
  bug elsewhere fails loudly here; there is no input that reaches it, and
  faking one would require corrupting the vault out of band.
- **`MathOverflow` / `DivByZero` / `InvalidInput` (6018–6020).** Same reason:
  the LMSR crate's own bounds are enforced before these can fire, and the
  reachable ones surface as `QOutOfRange` or `BOutOfRange` instead. Covered by
  Rust unit tests in `programs/greekbet/src/instructions/`.
- **Share-denominated buys.** No such instruction exists — see `parity.ts`
  above.
