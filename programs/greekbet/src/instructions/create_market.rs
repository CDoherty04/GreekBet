//! `create_market` — **owned by T06.**
//!
//! Creator deposits seed collateral and initialises LMSR state (plan §2.2).
//!
//! T05 provides only the skeleton below. T06 must:
//! * seed the vault with `lmsr::cost(0, 0, b)` — the `b·ln2` max subsidy —
//!   computed, never hardcoded;
//! * validate `b` via `lmsr::validate_b` -> `BOutOfRange`;
//! * validate `close_time > Clock::get()?.unix_timestamp` -> `CloseTimeInPast`;
//! * validate the question length via `state::validate_question_len`;
//! * verify `collateral_mint.decimals == lmsr::DECIMALS` -> `InvalidMintDecimals`;
//! * store `resolver` verbatim and otherwise unused (plan §2.2);
//! * store both bumps, set `status = Open`, `q_yes = q_no = 0`.

use anchor_lang::prelude::*;

use crate::state::Market;

/// Placeholder context. **T06 replaces this** with the full account set:
/// creator, market PDA, vault PDA (token account owned by the market PDA),
/// collateral mint, creator's token account, and the token/system/rent programs.
#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: placeholder — T06 replaces this with an `init` constraint and
    /// the real PDA seeds from `constants::MARKET_SEED`.
    pub market: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Handler. T06 owns the body.
pub fn create_market_handler(
    _ctx: Context<CreateMarket>,
    _question: String,
    _close_time: i64,
    _initial_liquidity_b: u64,
    _resolver: Pubkey,
) -> Result<()> {
    let _ = Market::LEN;
    todo!("T06 owns create_market")
}
