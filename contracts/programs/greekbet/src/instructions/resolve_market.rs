//! `resolve_market` — **owned by T06. Stub only, by design.**
//!
//! An access-controlled state write and nothing more (plan §2.2/§2.3). No
//! dispute, vote, or oracle logic belongs here in this phase — the resolver is a
//! bare pubkey stored by `create_market` and this is a deliberate seam for later
//! work, not an unfinished feature.
//!
//! `Closed → Resolved` is the only transition, and it is one-way: once
//! `winning_outcome` is written, nothing in the program can change or clear it.
//! That is what lets T08 treat a resolved market's LMSR state as frozen.

use anchor_lang::prelude::*;

use crate::constants::MARKET_SEED;
use crate::errors::GreekBetError;
use crate::state::{Market, MarketStatus, Outcome};

/// Accounts for [`resolve_market_handler`].
///
/// # The authority check is an account constraint, not a `require!`
///
/// `has_one = resolver @ GreekBetError::Unauthorized` compares
/// `market.resolver` against the `resolver` account's key, and `Signer<'info>`
/// forces that key to have signed. The two together are the whole of this
/// phase's access control. Expressed as constraints rather than as handler code
/// they run before the body, appear in the IDL (so a client can see the
/// requirement without reading the source), and cannot be dropped by a later
/// edit to the handler.
#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    /// The market to resolve. Must currently be `Closed`.
    #[account(
        mut,
        seeds = [MARKET_SEED, market.creator.as_ref(), market.question_hash.as_ref()],
        bump = market.bump,
        has_one = resolver @ GreekBetError::Unauthorized,
    )]
    pub market: Account<'info, Market>,

    /// The key stored in `market.resolver` at creation. A bare pubkey with no
    /// logic attached (plan §2.2) — being this key and signing is the entire
    /// authorization model.
    pub resolver: Signer<'info>,
}

/// Emitted once per successful `resolve_market`.
#[event]
pub struct MarketResolved {
    /// The market that transitioned to `Resolved`.
    pub market: Pubkey,
    /// The key that resolved it — equal to `market.resolver` by construction,
    /// emitted so an indexer need not join against the market account.
    pub resolver: Pubkey,
    /// The side that won. Winning shares redeem 1:1 (T08).
    pub winning_outcome: Outcome,
    /// `Clock::unix_timestamp` when resolution landed.
    pub resolved_at: i64,
    /// Final LMSR state, frozen at resolution.
    pub q_yes: u64,
    /// See [`Self::q_yes`].
    pub q_no: u64,
}

/// Write the winning outcome. Callable only by the stored resolver.
pub fn resolve_market_handler(ctx: Context<ResolveMarket>, winning_outcome: Outcome) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let resolver = ctx.accounts.resolver.key();
    let market = &mut ctx.accounts.market;

    // `MarketAlreadyResolved` is checked before `MarketNotClosed` so that each
    // illegal state gets its own specific code: a second call on a `Resolved`
    // market reports `MarketAlreadyResolved`, while a call on a still-`Open`
    // market reports `MarketNotClosed`. Checking `== Closed` first would
    // collapse both into `MarketNotClosed`, and T09 asserts exact codes.
    require!(
        !matches!(market.status, MarketStatus::Resolved),
        GreekBetError::MarketAlreadyResolved
    );
    require!(
        matches!(market.status, MarketStatus::Closed),
        GreekBetError::MarketNotClosed
    );

    market.winning_outcome = Some(winning_outcome);
    market.status = MarketStatus::Resolved;

    emit!(MarketResolved {
        market: market.key(),
        resolver,
        winning_outcome,
        resolved_at: now,
        q_yes: market.q_yes,
        q_no: market.q_no,
    });

    Ok(())
}
