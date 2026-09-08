//! `sell_shares` — **owned by T07.** Core trade path; test extensively.
//!
//! T07 must:
//! 1. apply the same status and `close_time` checks as `buy_shares`;
//! 2. require the position holds `>= share_amount` on that side ->
//!    `InsufficientShares`;
//! 3. `proceeds = lmsr::sell_return(q_yes, q_no, b, outcome, share_amount)`;
//! 4. require `proceeds >= min_usdc_out` -> `SlippageExceeded`;
//! 5. debit the position and decrement `q` **before** the transfer;
//! 6. transfer vault -> seller, signed by the market PDA
//!    (`CpiContext::new_with_signer`, seeds from `constants.rs` plus the stored
//!    `vault_bump`);
//! 7. check the vault actually holds `proceeds` -> `VaultInsolvent`. It should
//!    by construction; failing loudly beats an opaque token-program error.
//!
//! Rounding must never favour the user: proceeds round **down**.

use anchor_lang::prelude::*;

use crate::state::{Market, Outcome};

/// Placeholder context. **T07 replaces this**, mirroring `BuyShares` with the
/// transfer direction reversed and the market PDA as signing authority.
#[derive(Accounts)]
pub struct SellShares<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    pub system_program: Program<'info, System>,
}

/// Handler. T07 owns the body.
pub fn sell_shares_handler(
    _ctx: Context<SellShares>,
    _outcome: Outcome,
    _share_amount: u64,
    _min_usdc_out: u64,
) -> Result<()> {
    todo!("T07 owns sell_shares")
}
