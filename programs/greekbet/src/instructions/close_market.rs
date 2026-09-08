//! `close_market` — **owned by T06.**
//!
//! Marks a market `Closed` once `close_time` has passed, blocking further
//! trading (plan §2.2).
//!
//! T06 must: require `status == Open` -> `MarketNotOpen`; require
//! `Clock::get()?.unix_timestamp >= close_time` -> `CloseTimeNotReached`; set
//! `status = Closed`. Intended to be **permissionless** — anyone may crank it.

use anchor_lang::prelude::*;

use crate::state::Market;

/// Placeholder context. **T06 replaces this** with the real seeds constraint.
#[derive(Accounts)]
pub struct CloseMarket<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
}

/// Handler. T06 owns the body.
pub fn close_market_handler(_ctx: Context<CloseMarket>) -> Result<()> {
    todo!("T06 owns close_market")
}
