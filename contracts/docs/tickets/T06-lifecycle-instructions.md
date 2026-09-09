# T06 — `create_market`, `close_market`, `resolve_market`

**Depends on:** T05 · **Blocks:** T07, T08
**Owns:** `programs/greekbet/src/instructions/create_market.rs`,
`close_market.rs`, `resolve_market.rs`

## Context

Plan §2.2, §2.3. The market lifecycle minus trading and redemption. Do not edit
`state.rs`, `errors.rs`, or `lib.rs` (T05 owns them) — if you need a field or
error variant they lack, report it.

## Tasks

### `create_market(question, close_time, initial_liquidity_b, resolver_pubkey)`

- PDAs: `Market` seeded per T05's `constants.rs`; `MarketVault` as a PDA-owned
  SPL token account for `collateral_mint`, **authority = the market PDA** (plan
  §2.1).
- Validate:
  - `B_MIN <= initial_liquidity_b <= B_MAX` (`lmsr::bounds::validate_b`) →
    `BOutOfRange`.
  - `close_time > Clock::get()?.unix_timestamp` → `CloseTimeInPast`.
  - `question.len()` within the cap → `QuestionTooLong`. Store both the string
    and its hash.
- **Seed the vault.** Plan §2.2 says the creator deposits seed USDC. The correct
  amount is the LMSR max subsidy, `b·ln 2` — call `lmsr::cost(0, 0, b)` rather
  than hardcoding it, and transfer exactly that from the creator's token account
  into the vault. This is what makes the market solvent against the plan §1.4
  bound. State the reasoning in a comment.
- Init `q_yes = q_no = 0`, `status = Open`, `winning_outcome = None`, store
  `resolver_pubkey` verbatim, store `collateral_mint`, store both bumps.
- `resolver_pubkey` is **stored and otherwise unused** (plan §2.2). No validation
  of it beyond being a pubkey. Do not build resolver logic.

### `close_market(market)`

- Require `status == Open` → `MarketNotOpen`.
- Require `Clock::get()?.unix_timestamp >= close_time` → `CloseTimeNotReached`.
- Set `status = Closed`. Permissionless (anyone may crank it) — that is
  deliberate; note it in a comment.

### `resolve_market(market, winning_outcome)`

- **Stub only** (plan §2.2) — an access-controlled state write. No dispute, vote,
  or oracle logic.
- Require signer `== market.resolver` → `Unauthorized`. Use an explicit
  `has_one`/constraint so the check is visible in the account struct.
- Require `status == Closed` → `MarketNotClosed`. Reject if already `Resolved` →
  `MarketAlreadyResolved`.
- Set `winning_outcome` and `status = Resolved`.

## Design notes (plan §2.3)

- Validate market status on **every** instruction — build the checks in now.
- Prefer Anchor account constraints over imperative `require!` where possible;
  they are harder to forget and show up in the IDL.
- Every token account must be validated against `market.collateral_mint`
  (`InvalidMint`) and the vault against `market.vault` (`InvalidVault`).
- Emit an event per instruction (`MarketCreated`, `MarketClosed`,
  `MarketResolved`) — cheap now, and the indexer phase will need them.
- No `unwrap`, no unchecked arithmetic. Checked math everywhere.

## Definition of done

- `anchor build` succeeds.
- All three handlers implemented, no `todo!()` left in your files.
- Every listed validation present and mapped to the right error.
- Vault seeded via `lmsr::cost(0, 0, b)`, not a magic number.

## Report back

The exact seeding amount formula used, whether `close_market` ended up
permissionless, the account-constraint layout for the resolver authority check,
and anything you needed from T05's files.
