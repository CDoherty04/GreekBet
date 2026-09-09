# Phase status — plan §4.3 exit criteria

Written by T10, the final ticket. Each of the four criteria in
[`LMSR_ANCHOR_BUILD_PLAN.md`](./LMSR_ANCHOR_BUILD_PLAN.md) §4.3 is assessed
**met / partially met / not met**, with the evidence that supports it and the
caveats that qualify it. Everything below was re-run on **2026-09-09**; nothing
is quoted from an earlier ticket's report without being re-executed.

| # | Criterion | Verdict |
|---|---|---|
| 1 | LMSR module passes its full test suite, no known precision/overflow issues in the operating range | **Met** (one documented, bounded, structurally-avoided quirk) |
| 2 | All Anchor instructions pass local-validator tests across the full lifecycle | **Met** |
| 3 | The same lifecycle run at least once on devnet with real devnet USDC transfers | **Met** (needed one manual faucet drip — the faucet is not scriptable) |
| 4 | Resolver authority access control verified | **Met** (locally *and* on devnet) |

---

## 1. LMSR module test suite — **MET**

`cargo test -p lmsr`, re-run 2026-09-09, **91 tests, 0 failures**:

```
running 48 tests   test result: ok. 48 passed  (conformance)
running 21 tests   test result: ok. 21 passed  (properties)
running  7 tests   test result: ok.  7 passed
running  6 tests   test result: ok.  6 passed
running  5 tests   test result: ok.  5 passed
running  3 tests   test result: ok.  3 passed
running  1 test    test result: ok.  1 passed
```

Behind those 91 test functions, per
[`crates/lmsr/tests/README.md`](../crates/lmsr/tests/README.md):

* **7,135 comparisons** against an independent 60-digit `mpmath` oracle, over
  3,988 committed golden vectors.
* **~24,600 proptest cases plus a 120,000-case deterministic sweep** on the
  invariants.
* **~1.9M calls** in `boundaries.rs` proving no legal, illegal or absurd input
  can panic a public function.
* `Fixed::exp`'s positive branch characterised over a 43,600-point sweep.
* **Compute units measured in a real Solana VM**, not modelled: a
  `buy_shares`-shaped sequence costs 64,229 CU (32% of the 200,000 default),
  worst-column upper bound 86,319. `compute_budget.rs` asserts a 100,000 CU
  ceiling on the LMSR maths of any one instruction, leaving the rest for Anchor
  and the token CPI.

**Overflow** is structurally avoided rather than merely bounds-checked: the cost
function is evaluated in log-sum-exp stabilised form, so both `exp` arguments are
`≤ 0` and both results land in `(0, 1]` regardless of `q` or `b`
(`docs/DESIGN_DECISIONS.md` D4).

### The one caveat, stated plainly

T04 found and *reported* (did not patch — it does not own `src/`) that
`buy_cost(shares_for_cost(c))` can exceed `c` by **exactly +1 base unit** on
roughly 1 in 10,000 random `(state, budget)` pairs, at every `b` decade. The
cause is inherent: `b·ln(z)` carries a `b`-scaled absolute error of ~2.7e-8 base
units at `b = B_MAX`, and whenever the exact `ΔC` falls that close below an
integer, `ceil` rounds the wrong way.

This is assessed as **not blocking** the criterion because:

* it is `+1` in the **protocol's** favour, never the user's;
* 6,000,000 sampled buy-then-sell round trips gave **0** solvency violations;
* it is pinned by two tests, so a future fix is detectable rather than silent;
* **`buy_shares` is not written in the shape that would hit it.** T07 charges
  exactly `usdc_amount` rather than re-quoting through `buy_cost`, which is also
  what the reference ledger does. The on-chain path cannot reach the defect.

Calling this "no known precision issues" would be false; calling it a blocker
would also be false. It is a known, bounded, characterised, and structurally
avoided quirk.

**Also not covered, by design:** re-measuring compute units in CI (`cargo test`
has no Solana VM — the figures are recorded constants with a one-command
reproduction), and the `MAX_Q` cap, which the crate deliberately leaves
unclamped for `buy_shares` to enforce.

---

## 2. Local-validator lifecycle tests — **MET**

`anchor test --validator legacy --skip-build`, re-run 2026-09-09:

```
44 passing (5m)
11 pending
```

The 11 pending are `tests/devnet/lifecycle.ts` self-skipping — it is inside
Anchor.toml's `tests/**/*.ts` glob and correctly refuses to run against a local
validator. Not a skipped assertion; the same file passes 11/11 against devnet
(criterion 3).

Coverage, all against a real `solana-test-validator` with real SPL transfers:

* **`tests/lifecycle.ts`** — create → buy (three users) → sell → close →
  resolve → redeem, in order, sharing state. Vault seeded with exactly
  `floor(b·ln2)`; every step ends with a **zero-tolerance** solvency assertion
  (`vault == seed + Σin − Σout`, and `vault ≥ max(q_yes, q_no)`); winners paid
  1:1, loser paid zero and rent refunded.
* **`tests/negative.ts`** — 23 failure paths, each asserted against its **own**
  error code, not merely "it threw": `BOutOfRange`, `CloseTimeInPast`,
  `QuestionTooLong`, `InvalidMintDecimals`, `SlippageExceeded` (both
  directions), `InsufficientShares`, `ZeroCostTrade`, `InvalidMint`,
  `InvalidVault`, `QOutOfRange`, `CloseTimeNotReached`, `MarketNotClosed`,
  `MarketNotResolved`, `MarketNotOpen`, `Unauthorized`,
  `MarketAlreadyResolved`, `NothingToRedeem`, `AccountNotInitialized` (3012),
  and the position-PDA seed constraint.
* **`tests/parity.ts`** — 61 on-chain steps replayed against
  `reference/vectors/trades.json` with **zero tolerance**, across all six `b`
  decades, plus a decomposition of the post-redemption residual into unspent
  LMSR subsidy vs rounding dust (dust asserted `≥ 0` and `≤ 1` base unit per
  step).
* **`tests/concurrency.ts`** — interleaved trades against one market.

Plus **33 in-program Rust unit tests** (`cargo test -p greekbet --lib`,
33 passed) pinning account sizes, error discriminants and the pure helpers.

Every instruction fit the 200,000 CU default with no budget instruction; the
dearest was `sell_shares` at 61,107 CU (30.6%).

---

## 3. Devnet lifecycle with real devnet USDC — **MET**

Run 2026-09-09 against devnet (Agave `4.3.0-rc.0`), program
`GRUTmtYopUczvS5m62YAvctbS9TTrbznnnj5GmFHumSZ`, collateral **Circle's devnet
USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`** — the exact mint
`docs/DESIGN_DECISIONS.md` D3 names. **11 passing.**

Ten on-chain signatures, one per lifecycle step, are tabulated with explorer
links in [`DEVNET.md` §4](./DEVNET.md#4-the-successful-lifecycle-run--real-circle-devnet-usdc).
The market is `ASLXx7YqejsLNqjEFCu5tsQ92w9hdz9t6ekPD3Zo9H9R`, its vault
`5uoCeLAiSTTV46GKdEW2rLERzwNqvLmbkWuUQLT239tX`, and the four USDC distribution
transfers are listed there too. Full record in
`~/.greekbet-devnet/lifecycle-run.json`.

The devnet run asserts the *same* numbers as the local one, with no loosened
tolerances: exact vault bookkeeping, `payouts == q_yes` at resolution,
`residual == seed + Σin − Σout`, `residual ≤ b·ln2`.

### Caveats the reader must have

1. **The funding was not fully unattended, and cannot be.** Plan §3 wants test
   wallets funded "without manual intervention each time". Circle's faucet is
   reCAPTCHA-v3-gated — the drip mutation returns
   `{"code":"RECAPTCHA_ERROR","message":"ReCAPTCHA verification failed"}` to a
   correctly-formed request — and its REST API needs a developer key. **No
   script can drip Circle USDC.** The treasury was topped up by hand (20 USDC,
   two 10-USDC drips); everything downstream of that is scripted and repeatable.
   `scripts/devnet/fund.ts` implements all three of the ticket's paths and
   records which one ran in `funding.json` (`collateralPath`,
   `isRealCircleUsdc`).

   The devnet **SOL** faucet is likewise unavailable — rate-limited to zero from
   this host on every attempt — so test wallets are funded by transfer from the
   treasury rather than by airdrop.

2. **The Circle-mint run is scaled down.** A drip is 10 USDC, so the Circle
   fixture uses `b = B_MIN` (10 USDC) and buys of 1.0 / 0.4 / 2.0. An earlier
   devnet run on a **custom** 6-decimal mint used the local suite's exact
   parameters (`b` = 100, buys of 10 / 4 / 20) and also passed 11/11; it is kept
   because it makes the local-vs-devnet compute comparison apples-to-apples. The
   two runs produced identical arithmetic modulo the 10× scale, which is itself
   evidence the fixed-point maths is deterministic across validator versions.

3. **Anchor's on-chain IDL upload failed** (`Error: Failed to initialize IDL`)
   while the program itself deployed correctly. The metadata account holds a
   **truncated** IDL — 37,074 bytes inflate out of the local file's 48,178, the
   zlib stream never reaches EOF, and the JSON cuts off mid-string. Nothing in
   this repo reads it (everything loads `target/idl/greekbet.json` from disk),
   but explorers and any third-party client that resolves the interface from the
   program address alone do. See
   [`DEVNET.md` §5.6](./DEVNET.md#56-anchor-deploy-fails-after-successfully-deploying-the-program)
   for the measurement and the repair command.

### Plan §4.2's actual purpose — "to catch anything the local validator doesn't surface"

It caught things. Recorded in full in
[`DEVNET.md` §5](./DEVNET.md#5-what-behaved-differently-from-the-local-validator):

* **SPL Token CPIs cost ~4,564 CU less on devnet** (Agave 4.3.0-rc.0) than on
  the local validator (3.1.10) — the token program logs 76-233 CU per CPI there.
  Every CPI-free instruction is +5 CU. So the local figures are the conservative
  ones; no instruction needs a raised compute budget on either.
* The public RPC returns **429 in every run**, in bursts, and refuses
  `getTokenLargestAccounts` outright. A confirmed signature can 404 from
  `getTransaction` for seconds.
* Confirmation latency **600-2,000 ms** (up to 9 s under backoff) vs 40-500 ms
  locally, which makes `AnchorProvider.env()`'s default `processed` commitment
  actively wrong rather than merely flaky.
* A naive retry on blockhash expiry would **double-apply a `buy_shares`** —
  the test checks `getSignatureStatus` before rebuilding.
* Rent is a real budget item: the first deploy is 1.67 SOL and there is no
  airdrop to replace it.

---

## 4. Resolver authority access control — **MET**

Verified in two places, on two clusters.

**Locally** (`tests/negative.ts`): `resolve_market` from a stranger →
`Unauthorized` (6006); from the market **creator** → `Unauthorized` (6006); the
market status is still `Closed` afterwards. Plus `resolve_market` twice →
`MarketAlreadyResolved`, and `resolve_market` before `close_market` →
`MarketNotClosed`.

**On devnet** (`tests/devnet/lifecycle.ts`, a named exit criterion so it is not
left to the local run): the same two rejections against the deployed program,
followed by a successful resolve by the designated resolver.

The mechanism is worth recording because it explains the error code: the check
is `has_one = resolver @ GreekBetError::Unauthorized`, an **account
constraint**, evaluated inside `try_accounts` *before* the handler's status
checks. That is why an impostor gets `Unauthorized` rather than a status error
regardless of what state the market is in, and why the constraint cannot be
dropped by a later edit to the handler body.

---

## Ticket status

All 11 tickets complete — see [`tickets/README.md`](./tickets/README.md).

## What a follow-on phase should pick up

Out of scope here, but now visible:

1. **The `buy_cost` `+1`** (§1). Not reachable from the current instructions,
   but any future code that re-quotes through `buy_cost` will hit it.
2. **The on-chain IDL** is incomplete on devnet (§3, caveat 3). Any client that
   fetches the IDL from chain rather than from the repo will need it repaired.
3. **The program keypair lives in `~/.cache/greekbet-target/deploy/`**, outside
   the repo and gitignored, and a build regenerates it if missing — which mints
   a new program ID. It was already lost once during this phase and restored
   from a backup. `deploy.sh` now guards and backs up, but the backup directory
   (`~/.greekbet-devnet/keypair-backups/`) is still on one machine.
4. **Upgrade authority is an unprotected local keypair** — deliberate per plan
   §3 ("no need to lock this down yet"), and the first thing to change before
   anything with value touches this program.
5. **The public devnet RPC is not good enough** for sustained integration
   testing (§3). A dedicated endpoint via `ANCHOR_PROVIDER_URL` would remove
   most of the retry machinery's reason to exist.
