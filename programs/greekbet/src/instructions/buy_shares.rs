//! `buy_shares` — **owned by T07.** Core trade path; test extensively.
//!
//! T07 must, in this order (compute and validate everything *before* any token
//! transfer or state mutation, so a failure leaves no partial state):
//! 1. require `status == Open` -> `MarketNotOpen` **and**
//!    `now < close_time` — a market past its close time is untradeable even if
//!    nobody has cranked `close_market` yet;
//! 2. init-if-needed the `UserPosition` PDA;
//! 3. `shares = lmsr::shares_for_cost(q_yes, q_no, b, outcome, usdc_amount)`;
//! 4. enforce slippage on-chain -> `SlippageExceeded` (plan §2.3 makes this a
//!    security guarantee, never the client's job). Document the exact semantics
//!    of `max_slippage` in the handler doc comment;
//! 5. transfer collateral buyer -> vault;
//! 6. credit the position, update `q`, and enforce `lmsr::MAX_Q` ->
//!    `QOutOfRange`. **The LMSR crate does not clamp** — that is deliberate and
//!    the cap is the program's job;
//! 7. decide the zero-cost-trade question (`ZeroCostTrade`) per
//!    `docs/tickets/T07-trading-instructions.md` 6a, and say which way you went.
//!
//! Rounding must never favour the user: cost rounds up. Do not add any scaling
//! or rounding of your own on top of the LMSR crate's output — T09 asserts the
//! on-chain result matches the crate exactly.

use anchor_lang::prelude::*;

use crate::state::{Market, Outcome, UserPosition};

/// Placeholder context. **T07 replaces this** with buyer, market, vault,
/// position PDA, collateral mint, buyer's token account, and the token/system
/// programs — every token account validated against `market.collateral_mint`
/// and `market.vault`.
#[derive(Accounts)]
pub struct BuyShares<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    pub system_program: Program<'info, System>,
}

/// Handler. T07 owns the body.
pub fn buy_shares_handler(
    _ctx: Context<BuyShares>,
    _outcome: Outcome,
    _usdc_amount: u64,
    _max_slippage: u64,
) -> Result<()> {
    let _ = UserPosition::LEN;
    todo!("T07 owns buy_shares")
}
