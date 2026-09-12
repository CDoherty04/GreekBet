//! `close_market` — **owned by T06.**
//!
//! Marks a market `Closed`, blocking further trading (plan §2.2).
//! `Open → Closed` is the only transition it performs and nothing here moves
//! tokens.
//!
//! # Who may close
//!
//! * **Anyone**, once `close_time` has passed — permissionless crank so a
//!   market can never get stuck unclosable if the resolver key is lost.
//! * **The stored resolver**, at any time — so an AI / owner verdict can
//!   settle on chain immediately without waiting out the trading window.
//!   App-level trading already pauses once a resolution record exists; early
//!   close freezes the on-chain book to match.

use anchor_lang::prelude::*;

use crate::constants::MARKET_SEED;
use crate::errors::GreekBetError;
use crate::state::{Market, MarketStatus};

/// Accounts for [`close_market_handler`].
#[derive(Accounts)]
pub struct CloseMarket<'info> {
    /// The market to close. Must currently be `Open`.
    #[account(
        mut,
        seeds = [MARKET_SEED, market.creator.as_ref(), market.question_hash.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// Crank signer. Anyone after `close_time`; the market's resolver may
    /// close earlier to settle a reached conclusion.
    pub authority: Signer<'info>,
}

/// Emitted once per successful `close_market`.
#[event]
pub struct MarketClosed {
    /// The market that transitioned to `Closed`.
    pub market: Pubkey,
    /// The `close_time` the market was created with.
    pub close_time: i64,
    /// `Clock::unix_timestamp` when the crank actually landed.
    pub closed_at: i64,
    /// LMSR state frozen at close.
    pub q_yes: u64,
    /// See [`Self::q_yes`].
    pub q_no: u64,
}

/// Crank a market from `Open` to `Closed`.
pub fn close_market_handler(ctx: Context<CloseMarket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let authority = ctx.accounts.authority.key();
    let market = &mut ctx.accounts.market;

    require!(market.is_open(), GreekBetError::MarketNotOpen);

    let past_close = now >= market.close_time;
    let resolver_early = authority == market.resolver;
    require!(
        past_close || resolver_early,
        GreekBetError::CloseTimeNotReached
    );

    market.status = MarketStatus::Closed;

    emit!(MarketClosed {
        market: market.key(),
        close_time: market.close_time,
        closed_at: now,
        q_yes: market.q_yes,
        q_no: market.q_no,
    });

    Ok(())
}
