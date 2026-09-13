//! `reclaim_subsidy` — return unspent LMSR subsidy to the market creator.
//!
//! After resolution the vault must still cover every outstanding winning share
//! (1:1). Anything above that obligation is the creator's unspent seed / trading
//! edge and may be withdrawn.
//!
//! `redeem` decrements the winning-side `q` on current builds. Markets redeemed
//! *before* that change still carry a stale full `q_win` even though winners
//! were paid. The caller therefore passes `remaining_winning_shares` — the
//! still-unredeemed winning supply — which must be `<=` the on-chain `q_win`.
//! The instruction writes that value onto the market, then pays
//!
//! ```text
//! reclaimable = vault.amount − remaining_winning_shares
//! ```
//!
//! Passing `0` after every winner has redeemed returns the full residual.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::MARKET_SEED;
use crate::errors::GreekBetError;
use crate::state::{Market, Outcome};

/// Accounts for [`reclaim_subsidy_handler`].
#[derive(Accounts)]
pub struct ReclaimSubsidy<'info> {
    /// The market creator — the key that deposited the LMSR seed. Must sign.
    #[account(mut)]
    pub creator: Signer<'info>,

    /// Resolved market. `has_one = creator` is the whole of the access control.
    /// `mut` so a stale pre-upgrade `q_win` can be synced down to
    /// `remaining_winning_shares` before the residual is paid.
    #[account(
        mut,
        seeds = [MARKET_SEED, market.creator.as_ref(), market.question_hash.as_ref()],
        bump = market.bump,
        has_one = creator @ GreekBetError::NotMarketCreator,
    )]
    pub market: Account<'info, Market>,

    /// The market's collateral vault.
    #[account(
        mut,
        address = market.vault @ GreekBetError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Creator's token account for the market's collateral mint.
    #[account(
        mut,
        constraint = creator_token_account.mint == market.collateral_mint
            @ GreekBetError::InvalidMint,
    )]
    pub creator_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Emitted when the creator pulls residual subsidy from the vault.
#[event]
pub struct SubsidyReclaimed {
    /// The market whose vault was drained of residual.
    pub market: Pubkey,
    /// The creator who received the residual.
    pub creator: Pubkey,
    /// Collateral base units transferred out.
    pub amount: u64,
    /// Winning-side shares still outstanding after this reclaim.
    pub outstanding_winning_shares: u64,
    /// Vault balance left for those outstanding shares.
    pub vault_remaining: u64,
}

/// Sync outstanding winning supply, then return `vault − remaining` to the creator.
pub fn reclaim_subsidy_handler(
    ctx: Context<ReclaimSubsidy>,
    remaining_winning_shares: u64,
) -> Result<()> {
    let winning_outcome: Outcome = ctx.accounts.market.require_resolved()?;
    let q_win = match winning_outcome {
        Outcome::Yes => ctx.accounts.market.q_yes,
        Outcome::No => ctx.accounts.market.q_no,
    };

    // Caller may lower a stale pre-upgrade `q_win`, but must not invent a
    // higher obligation than the book already claims.
    require!(
        remaining_winning_shares <= q_win,
        GreekBetError::InsufficientShares
    );

    {
        let market = &mut ctx.accounts.market;
        match winning_outcome {
            Outcome::Yes => market.q_yes = remaining_winning_shares,
            Outcome::No => market.q_no = remaining_winning_shares,
        }
    }

    let vault_amount = ctx.accounts.vault.amount;
    require!(
        vault_amount >= remaining_winning_shares,
        GreekBetError::VaultInsolvent
    );
    let residual = vault_amount
        .checked_sub(remaining_winning_shares)
        .ok_or(GreekBetError::MathOverflow)?;
    require!(residual > 0, GreekBetError::NothingToReclaim);

    let market = &ctx.accounts.market;
    let market_bump = [market.bump];
    let market_seeds: &[&[u8]] = &[
        MARKET_SEED,
        market.creator.as_ref(),
        market.question_hash.as_ref(),
        &market_bump,
    ];
    let signer_seeds = &[market_seeds];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.creator_token_account.to_account_info(),
                authority: market.to_account_info(),
            },
            signer_seeds,
        ),
        residual,
    )?;

    emit!(SubsidyReclaimed {
        market: market.key(),
        creator: ctx.accounts.creator.key(),
        amount: residual,
        outstanding_winning_shares: remaining_winning_shares,
        vault_remaining: remaining_winning_shares,
    });

    Ok(())
}
