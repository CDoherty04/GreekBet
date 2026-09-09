//! `close_market` — **owned by T06.**
//!
//! Marks a market `Closed` once `close_time` has passed, blocking further
//! trading (plan §2.2). `Open → Closed` is the only transition it performs and
//! nothing here moves tokens.
//!
//! # This instruction is deliberately permissionless
//!
//! There is **no signer in the account struct**. Anyone may crank it, and that
//! is intentional rather than an oversight:
//!
//! * The state transition carries no discretion. The only inputs are the
//!   market's own stored `status` and `close_time` against the on-chain
//!   `Clock`, so every caller who succeeds produces byte-identical state. There
//!   is nothing for an authority to decide.
//! * Gating it on the creator or the resolver would make a market *permanently
//!   untradeable-but-unclosable* if that key went away — and `resolve_market`
//!   requires `Closed`, so a market could never be resolved and every position
//!   in it would be stranded. Liveness must not depend on a single key.
//! * It is not an attack surface. It cannot be called early
//!   ([`GreekBetError::CloseTimeNotReached`]) or twice
//!   ([`GreekBetError::MarketNotOpen`]), and the resulting state is the one the
//!   creator already committed to at `close_time`.
//!
//! A transaction still needs a fee payer, but that signer is a property of the
//! transaction, not of this instruction — no account here is a `Signer`.
//!
//! Note that a market past `close_time` is untradeable whether or not anyone
//! has cranked this: T07 must check `close_time` as well as `status`, so the
//! crank is a bookkeeping step, not the security boundary for trading.

use anchor_lang::prelude::*;

use crate::constants::MARKET_SEED;
use crate::errors::GreekBetError;
use crate::state::{Market, MarketStatus};

/// Accounts for [`close_market_handler`].
///
/// One account, no signer. The seeds constraint re-derives the market from the
/// creator and question hash it stores, so a `Market`-shaped account of this
/// program that is not at its own canonical PDA cannot be passed in.
#[derive(Accounts)]
pub struct CloseMarket<'info> {
    /// The market to close. Must currently be `Open` and past its `close_time`.
    #[account(
        mut,
        seeds = [MARKET_SEED, market.creator.as_ref(), market.question_hash.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
}

/// Emitted once per successful `close_market`.
#[event]
pub struct MarketClosed {
    /// The market that transitioned to `Closed`.
    pub market: Pubkey,
    /// The `close_time` the market was created with.
    pub close_time: i64,
    /// `Clock::unix_timestamp` when the crank actually landed. Always
    /// `>= close_time`, and the gap is however long it took someone to crank.
    pub closed_at: i64,
    /// LMSR state frozen at close, so an indexer does not have to re-read the
    /// account to know the final supply.
    pub q_yes: u64,
    /// See [`Self::q_yes`].
    pub q_no: u64,
}

/// Crank a market from `Open` to `Closed`.
pub fn close_market_handler(ctx: Context<CloseMarket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = &mut ctx.accounts.market;

    // Status first, then time. Order matters for T09's negative tests: an
    // already-`Closed` or `Resolved` market must report `MarketNotOpen`, not
    // something about the clock.
    require!(market.is_open(), GreekBetError::MarketNotOpen);
    require!(now >= market.close_time, GreekBetError::CloseTimeNotReached);

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
