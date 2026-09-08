//! # GreekBet — binary YES/NO prediction markets priced by an LMSR AMM
//!
//! Devnet/testnet only. No real funds (plan, "Key decisions locked in").
//!
//! ## Shape of this program
//!
//! * Pricing is an **LMSR automated market maker**, implemented in the
//!   `lmsr` crate (`crates/lmsr`) — pure, `no_std`, dependency-free, and tested
//!   against a high-precision Python oracle before this program ever calls it.
//!   Treat it as a trusted dependency and do not re-derive its maths here.
//! * Custody is **fully on-chain**: collateral lives in a per-market vault
//!   token account whose authority is the market PDA.
//! * Positions are **internal program state** (`UserPosition`), not SPL tokens
//!   — `docs/DESIGN_DECISIONS.md` D2. Shares are therefore non-transferable.
//! * The collateral mint is **per-market runtime config** (D3), never a
//!   constant: local tests use a throwaway 6-decimal mint, devnet uses Circle's
//!   USDC.
//! * The resolver is a **bare pubkey with no logic attached** (plan §2.2) — a
//!   deliberate placeholder seam. `dispute_market`, oracles, and voting are
//!   explicitly out of scope for this phase.
//!
//! ## Units
//!
//! Everything — `b`, `q_yes`, `q_no`, collateral, share counts — is in
//! **6-decimal base units**, the same unit the LMSR crate takes and returns.
//! Nothing is rescaled at the boundary, which is what makes redemption a
//! straight 1:1 mapping.
//!
//! ## Building
//!
//! `anchor build --arch v0` is **mandatory**. Anchor 1.2.0 defaults to sbpf v3,
//! which Agave 3.1.10 cannot load (`invalid file header` on deploy,
//! `Unsupported program id` at the validator). `anchor test` has no `--arch`
//! flag, so it must be given `--skip-build` after an explicit build, and
//! `--validator legacy` to select `solana-test-validator` over Anchor 1.2's
//! default `surfpool`. See `docs/TOOLCHAIN.md`.

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

pub use constants::*;
pub use errors::GreekBetError;
pub use instructions::*;
pub use state::{Market, MarketStatus, Outcome, UserPosition};

declare_id!("GRUTmtYopUczvS5m62YAvctbS9TTrbznnnj5GmFHumSZ");

#[program]
pub mod greekbet {
    use super::*;

    /// Create a market and seed its vault with the LMSR max subsidy.
    ///
    /// `resolver` is stored verbatim and otherwise unused in this phase.
    /// **Owned by T06.**
    pub fn create_market(
        ctx: Context<CreateMarket>,
        question: String,
        close_time: i64,
        initial_liquidity_b: u64,
        resolver: Pubkey,
    ) -> Result<()> {
        instructions::create_market::create_market_handler(
            ctx,
            question,
            close_time,
            initial_liquidity_b,
            resolver,
        )
    }

    /// Buy `outcome` shares by depositing `usdc_amount` of collateral.
    ///
    /// Slippage is enforced **on-chain** (plan §2.3). **Owned by T07.**
    pub fn buy_shares(
        ctx: Context<BuyShares>,
        outcome: Outcome,
        usdc_amount: u64,
        max_slippage: u64,
    ) -> Result<()> {
        instructions::buy_shares::buy_shares_handler(ctx, outcome, usdc_amount, max_slippage)
    }

    /// Sell `share_amount` of `outcome` back to the market.
    ///
    /// Fails unless proceeds are at least `min_usdc_out`. **Owned by T07.**
    pub fn sell_shares(
        ctx: Context<SellShares>,
        outcome: Outcome,
        share_amount: u64,
        min_usdc_out: u64,
    ) -> Result<()> {
        instructions::sell_shares::sell_shares_handler(ctx, outcome, share_amount, min_usdc_out)
    }

    /// Mark a market closed once `close_time` has passed. Permissionless.
    ///
    /// **Owned by T06.**
    pub fn close_market(ctx: Context<CloseMarket>) -> Result<()> {
        instructions::close_market::close_market_handler(ctx)
    }

    /// Write the winning outcome. Callable only by the stored resolver.
    ///
    /// An access-controlled state write and nothing more — no dispute, vote, or
    /// oracle logic in this phase. **Owned by T06.**
    pub fn resolve_market(ctx: Context<ResolveMarket>, winning_outcome: Outcome) -> Result<()> {
        instructions::resolve_market::resolve_market_handler(ctx, winning_outcome)
    }

    /// Redeem a resolved position: winning shares 1:1, losing shares zero.
    ///
    /// **Owned by T08.**
    pub fn redeem(ctx: Context<Redeem>) -> Result<()> {
        instructions::redeem::redeem_handler(ctx)
    }
}
