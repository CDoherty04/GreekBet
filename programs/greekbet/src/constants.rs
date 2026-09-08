//! Program-wide constants: PDA seeds and account-size caps.
//!
//! **Seed literals are never inlined at a use site.** Every `seeds = [...]`
//! constraint and every `CpiContext::new_with_signer` seed slice in
//! T06/T07/T08 must reference the constants below, so a rename can never
//! silently orphan a PDA.
//!
//! Owned by T05. If you need a new seed, add it here rather than inlining one.

use anchor_lang::prelude::*;

/// Seed prefix for the [`Market`](crate::state::Market) PDA.
///
/// Full seeds: `[MARKET_SEED, creator.key(), question_hash]`.
/// Including the creator and the question hash lets the same creator run many
/// markets and keeps two creators asking the same question from colliding.
#[constant]
pub const MARKET_SEED: &[u8] = b"market";

/// Seed prefix for the market's collateral vault (an SPL token account owned
/// by the market PDA).
///
/// Full seeds: `[VAULT_SEED, market.key()]`.
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

/// Seed prefix for a [`UserPosition`](crate::state::UserPosition) PDA.
///
/// Full seeds: `[POSITION_SEED, market.key(), owner.key()]` — one position
/// account per (market, user) pair, per `docs/DESIGN_DECISIONS.md` D2.
#[constant]
pub const POSITION_SEED: &[u8] = b"position";

/// Hard cap on the UTF-8 byte length of [`Market::question`](crate::state::Market::question).
///
/// A `String` in an Anchor account is only bounded by what the account was
/// allocated for, so an unbounded question is an account-size bug waiting to
/// happen: the account is sized once at `init` and a longer string simply fails
/// to serialise (or, worse, silently truncates a client's expectations).
/// 200 bytes is enough for a real prediction-market question and keeps
/// [`Market::LEN`](crate::state::Market::LEN) at 417 bytes.
///
/// T06's `create_market` must reject anything longer with
/// [`GreekBetError::QuestionTooLong`](crate::errors::GreekBetError::QuestionTooLong)
/// — see [`crate::state::validate_question_len`].
pub const MAX_QUESTION_LEN: usize = 200;

/// The number of decimals the collateral mint is required to have.
///
/// Shares and collateral are both 6-decimal base units, which is what makes
/// redemption a straight 1:1 unit mapping (T08) and what the LMSR crate assumes
/// (`lmsr::DECIMALS`). Both the local test mint and Circle's devnet USDC are
/// 6-decimal (`docs/DESIGN_DECISIONS.md` D3).
///
/// Note this constrains the mint's *decimals*, not its address — the mint
/// address itself is per-market runtime config, never a constant.
pub const COLLATERAL_DECIMALS: u8 = lmsr::DECIMALS;
