# T08 — `redeem`

**Depends on:** T06 · **Blocks:** T09
**Owns:** `programs/greekbet/src/instructions/redeem.rs`

## Context

Plan §2.2: *"Winning shares redeem 1:1 for USDC from vault; losing shares redeem
for zero. Depends only on `resolve_market` having run."*

Independent of T07 — you can build against the `UserPosition` account without
knowing how the shares got there.

Do not edit `state.rs`, `errors.rs`, or `lib.rs`.

## Tasks

1. Require `status == Resolved` → `MarketNotResolved`, and `winning_outcome` is
   `Some` (it is by construction, but do not `unwrap` — return an error).
2. Read the caller's `UserPosition`. Payout = winning-side shares × 1 USDC base
   unit per share; losing-side shares pay zero. Since both shares and USDC use
   6 decimals, 1:1 is a direct unit mapping — assert that assumption in a comment
   so it survives a future decimals change.
3. Zero **both** `yes_shares` and `no_shares` before transferring — the losing
   side must be cleared too, or a second `redeem` call could re-process a
   position. Set state first, then CPI.
4. If total payout is zero (holder had only losing shares), still succeed and
   still zero the position. Only error with `NothingToRedeem` if the position is
   already empty — otherwise a loser cannot close out their account.
5. Transfer from the vault signed by the market PDA (seeds from `constants.rs` +
   stored `vault_bump`). Validate the destination token account against
   `market.collateral_mint`, and the vault against `market.vault`.
6. **Vault solvency:** check the vault holds the payout and fail cleanly with a
   clear error if not. LMSR guarantees solvency mathematically; a failure here
   means an accounting bug elsewhere and must be loud, not an opaque token-program
   error.
7. Consider closing the `UserPosition` account and returning rent to the owner
   once fully redeemed. Do it if it is clean; if it complicates re-entrancy, skip
   it and say why.
8. Emit a `Redeemed` event.

## Non-negotiables

- **State before CPI.** Zero the position, then transfer. Never the reverse.
- No `unwrap` on `winning_outcome`.
- Checked arithmetic on the payout.
- Double-redeem must be impossible. Call this out explicitly in your report —
  T09 will write a test that tries it.

## Definition of done

- `anchor build` succeeds, no `todo!()` in your file.
- Winner paid 1:1, loser paid zero, both cases clear the position.
- Double-redeem impossible by construction.
- Vault solvency checked with a clear error.

## Report back

Whether you close the `UserPosition` account and why, exactly how double-redeem
is prevented, and the payout formula including the decimals assumption.
