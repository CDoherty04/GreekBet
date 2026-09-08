//! `resolve_market` — **owned by T06. Stub only, by design.**
//!
//! An access-controlled state write and nothing more (plan §2.2/§2.3). No
//! dispute, vote, or oracle logic belongs here in this phase — the resolver is
//! a bare pubkey and this is a deliberate seam for later work.
//!
//! T06 must: require the signer is `market.resolver` -> `Unauthorized`, using
//! an explicit account constraint so the check is visible in the IDL; require
//! `status == Closed` -> `MarketNotClosed`; reject an already-`Resolved` market
//! -> `MarketAlreadyResolved`; write `winning_outcome` and set
//! `status = Resolved`.

use anchor_lang::prelude::*;

use crate::state::{Market, Outcome};

/// Placeholder context. **T06 replaces this**, adding
/// `has_one = resolver @ GreekBetError::Unauthorized`.
#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    pub resolver: Signer<'info>,
}

/// Handler. T06 owns the body.
pub fn resolve_market_handler(_ctx: Context<ResolveMarket>, _winning_outcome: Outcome) -> Result<()> {
    todo!("T06 owns resolve_market")
}
