//! `redeem` — **owned by T08.**
//!
//! Winning shares redeem 1:1 for collateral; losing shares redeem for zero
//! (plan §2.2). Depends only on `resolve_market` having run.
//!
//! T08 must:
//! 1. get the winner via `market.require_resolved()` — **never `unwrap`** the
//!    `Option`; that helper exists precisely so no handler has to;
//! 2. pay `winning_side_shares` 1:1 (shares and collateral are both 6-decimal
//!    base units — assert that assumption in a comment so it survives a future
//!    decimals change);
//! 3. **zero both `yes_shares` and `no_shares` before transferring.** Clearing
//!    the losing side too is what makes a second `redeem` a no-op; state first,
//!    CPI second, never the reverse;
//! 4. succeed with a zero payout when the holder had only losing shares, still
//!    clearing the position. `NothingToRedeem` is only for an already-empty
//!    position — otherwise a loser could never close out;
//! 5. check vault solvency -> `VaultInsolvent`;
//! 6. optionally close the position account and return rent, if it does not
//!    complicate re-entrancy. Say which you chose and why.
//!
//! T09 will write a test that calls this twice; double-redeem must be
//! impossible by construction.

use anchor_lang::prelude::*;

use crate::state::{Market, UserPosition};

/// Placeholder context. **T08 replaces this** with owner, market, position PDA,
/// vault, and the owner's token account — the destination validated against
/// `market.collateral_mint` and the vault against `market.vault`.
#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub position: Account<'info, UserPosition>,
}

/// Handler. T08 owns the body.
pub fn redeem_handler(_ctx: Context<Redeem>) -> Result<()> {
    todo!("T08 owns redeem")
}
