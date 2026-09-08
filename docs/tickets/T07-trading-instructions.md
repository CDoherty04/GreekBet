# T07 — `buy_shares` and `sell_shares`

**Depends on:** T04, T06 · **Blocks:** T09
**Owns:** `programs/greekbet/src/instructions/buy_shares.rs`, `sell_shares.rs`

## Context

Plan §2.2 — *"core path to test extensively"* — and §2.3, which makes on-chain
slippage enforcement a security requirement, not a client convenience. This is
the ticket where a bug costs money.

Depends on T04 because the LMSR crate must be **proven** before the program
trusts it. Read T03's and T04's reports before starting: the exact API
signatures and rounding policy come from there.

Do not edit `state.rs`, `errors.rs`, `lib.rs`, or the `crates/lmsr` source.

## Tasks

### `buy_shares(market, outcome, usdc_amount, max_slippage)`

1. Require `status == Open` → `MarketNotOpen`, and
   `Clock::get()?.unix_timestamp < close_time` (a market past its close time is
   not tradeable even if nobody has cranked `close_market` yet — enforce it here).
2. Init-if-needed the `UserPosition` PDA for `(market, buyer)`.
3. Compute `shares = lmsr::shares_for_cost(q_yes, q_no, b, outcome, usdc_amount)`.
4. **Slippage.** `max_slippage` needs a defined meaning — pick one, document it
   in the handler doc comment, and be consistent with `sell_shares`. Recommended:
   a `min_shares_out` semantic (the user states the fewest shares they will
   accept), which is unambiguous and does not require the client to reason about
   average vs marginal price. If you keep a price-based reading instead, define
   precisely which price and in what units. Violation → `SlippageExceeded`.
5. Transfer `usdc_amount` from buyer's token account → vault (CPI to the token
   program).
6. Credit `UserPosition`, update `q_yes`/`q_no`, and check the new `q` against
   `MAX_Q` → `QOutOfRange`. **The LMSR crate deliberately does not clamp to
   `MAX_Q`** — `shares_for_cost` returns the mathematical answer and enforcing
   the cap is your job. T01 found 55 vector cases that legitimately exceed it,
   so this is a reachable path, not a theoretical one.

6a. **Decide the zero-cost-trade question and document it.** T01 established
   that at extreme skew (`(q_min − q_max)/b < −138`) the exact cost of a trade
   is below 1e-60, so `buy_cost` correctly rounds to **0** — a user can acquire
   shares of the near-certain-loser outcome for no collateral. The reference
   oracle deliberately does not floor this, and T01's 1,800-step solvency test
   shows the vault stays solvent because payout is bounded by
   `max(q_yes, q_no)`, which such trades do not raise.

   It is nonetheless a **free option**: zero cost, non-zero payoff if the
   long-shot resolves that way. Reaching that skew requires someone to have
   already paid in proportionally, so it is not a cheap attack — but decide it
   consciously rather than by omission. Options: (a) accept it and match the
   oracle exactly; (b) reject trades computing to zero collateral with a
   dedicated error. **(b) is the safer default for a money-handling program.**
   If you choose (b), say so loudly — it is a deliberate divergence from the
   oracle and T09's parity test must be told to expect it.
7. **Ordering:** compute and validate everything, including slippage, *before*
   any token transfer or state mutation. No partial state on the failure path.

### `sell_shares(market, outcome, share_amount, min_usdc_out)`

1. Same status and time checks.
2. Require the position holds `>= share_amount` of that outcome →
   `InsufficientShares`.
3. Compute `proceeds = lmsr::sell_return(q_yes, q_no, b, outcome, share_amount)`.
4. Require `proceeds >= min_usdc_out` → `SlippageExceeded`.
5. Debit the position, decrement `q`, then transfer `proceeds` vault → seller,
   signed by the **market** PDA (`CpiContext::new_with_signer`).

   **CORRECTION — the seeds this ticket originally specified were wrong, and
   T08 hit it.** The vault's *authority* is the market PDA, so the signer seeds
   are the **market's** seeds:

   ```rust
   let market_bump = [market.bump];
   let seeds: &[&[u8]] = &[
       MARKET_SEED,
       market.creator.as_ref(),
       market.question_hash.as_ref(),
       &market_bump,
   ];
   ```

   **`vault_bump` signs nothing** — it is the bump of the vault PDA's own
   derivation. Using it derives the wrong key. Pin the vault with an
   `address = market.vault @ GreekBetError::InvalidVault` constraint instead,
   which is what `redeem.rs` does; copy that file's approach.
6. **Vault solvency check:** the vault must hold `proceeds`. It should by
   construction, but assert it and fail cleanly rather than letting the token
   program throw an opaque error.

## Anchor 1.2.0 gotchas already paid for by other tickets

- **`CpiContext::new` / `new_with_signer` take the program `Pubkey`, not an
  `AccountInfo`.** `ctx.accounts.token_program.to_account_info()` is a compile
  error (`expected Pubkey, found AccountInfo`); use `.key()`. Most Anchor
  examples predate this change.
- **Handlers are named `<instruction>_handler`**, not `handler` —
  `instructions/mod.rs` must glob re-export (Anchor's `#[program]` needs the
  generated `__client_accounts_*` modules), so six modules exporting `handler`
  would be ambiguous. `lib.rs` already calls `buy_shares_handler` and
  `sell_shares_handler`; keep those signatures.
- **Convert LMSR errors with `.or_program_err()`** (the `LmsrResultExt` trait in
  `errors.rs`). A blanket `From<lmsr::LmsrError> for anchor_lang::Error` is
  impossible — orphan rule, both types foreign.
- **Define your events in your own instruction files.** There is no `events.rs`;
  `redeem.rs` defines `Redeemed` locally and T06 does the same. This keeps
  parallel tickets from colliding.
- **Read `programs/greekbet/src/instructions/redeem.rs` before you start.** It is
  finished, reviewed, and shows the house style for account constraints, PDA
  signing, solvency checks, and event payloads.

## Non-negotiables

- **Rounding must never favor the user.** Cost rounds up, proceeds round down.
  This is the vault-drain vector T04 property-tests; the program must not undo it.
- **Slippage is enforced on-chain** (plan §2.3), never delegated to the client.
- Checked arithmetic on every `q` and balance update → `MathOverflow`.
- Validate every token account against `market.collateral_mint` and
  `market.vault`.
- Emit `SharesBought` / `SharesSold` events with the pre/post state and price.
- The on-chain result must match the LMSR crate **exactly** — plan §4.2 requires
  the test suite to assert that, so do not introduce any rounding or scaling of
  your own on top of the crate's output.

## Definition of done

- `anchor build` succeeds, no `todo!()` in your files.
- Both handlers complete with all checks above.
- Slippage semantics documented in a doc comment on each handler.
- Compute usage is within budget for the largest legal trade (T04 measured the
  math cost; sanity-check the full instruction).

## Report back

The slippage semantics you chose and why, the exact LMSR calls made, the
CPI-signing seed layout, and any place the LMSR API did not fit the instruction
cleanly.
