//! `sell_shares` — **owned by T07.** The other half of the core trade path.
//!
//! The mirror of [`buy_shares`](super::buy_shares), and the *easy* direction:
//! the seller names a **share count**, so this is the LMSR cost function
//! evaluated forwards ([`lmsr::sell_return`]) rather than inverted. None of the
//! `shares_for_cost`/`buy_cost` round-trip trouble T04 found applies here.
//!
//! # What makes this instruction the dangerous one anyway
//!
//! It is the only trading path that moves collateral **out** of the vault, so it
//! is the only one that can drain it. Three things stand between it and that:
//!
//! 1. **Proceeds round down.** [`lmsr::sell_return`] floors, and nothing in this
//!    file rescales or re-rounds it. Rounding in the seller's favour, repeated
//!    over many dust-sized sells, is the classic drain.
//! 2. **The position is the authority on what may be sold**, not `q`. A seller
//!    can only unwind shares their own [`UserPosition`] holds, so the sum of all
//!    positions stays equal to `q` and no one can sell someone else's exposure.
//! 3. **The vault is checked before it is asked.** LMSR bounds the maker's loss
//!    at `b·ln 2`, which `create_market` deposits up front, so a shortfall here
//!    is an accounting bug elsewhere — and must surface as
//!    [`GreekBetError::VaultInsolvent`] rather than as an opaque SPL-token
//!    error.
//!
//! # PDA signing
//!
//! The vault's authority is the **market** PDA, so the withdrawal is signed with
//! the *market's* seeds and `market.bump`:
//!
//! ```text
//! [MARKET_SEED, market.creator, market.question_hash, &[market.bump]]
//! ```
//!
//! `market.vault_bump` signs **nothing** — it is the bump of the vault PDA's own
//! derivation, and signing with it derives the wrong key. T08 hit this; the
//! vault is instead pinned by `address = market.vault`. Same layout as
//! `redeem.rs`.
//!
//! # LMSR calls
//!
//! Two, against `compute_budget.rs`'s 100,000 CU ceiling on the maths of any one
//! instruction: [`lmsr::sell_return`] (25,730 CU worst column) and
//! [`lmsr::price_yes`] (12,315) for the event — **38,045 CU**, exactly the shape
//! T04's budget model reserved for this instruction.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::{MARKET_SEED, POSITION_SEED};
use crate::errors::{GreekBetError, LmsrResultExt};
use crate::state::{Market, Outcome, UserPosition};

/// Accounts for [`sell_shares_handler`].
///
/// Mirrors [`BuyShares`](super::buy_shares::BuyShares) with the transfer
/// direction reversed. The one structural difference: the position is **not**
/// `init_if_needed` — you cannot sell out of a position that does not exist, so
/// a missing account fails deserialisation before the handler runs, and that
/// lets `has_one = market` be used here where the buy side could not.
#[derive(Accounts)]
pub struct SellShares<'info> {
    /// The position holder. Must sign; only this key can unwind this position.
    #[account(mut)]
    pub seller: Signer<'info>,

    /// The market being traded. `mut` because `q_yes` / `q_no` move.
    ///
    /// This account also supplies the seeds that sign the vault withdrawal, so
    /// it is pinned to its own canonical PDA as well as being checked for owner
    /// and discriminator by `Account<_, Market>`.
    #[account(
        mut,
        seeds = [MARKET_SEED, market.creator.as_ref(), market.question_hash.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// The seller's position in this market.
    ///
    /// Deliberately **not** closed when it empties out. A seller who unwinds
    /// their whole holding keeps a zeroed position account (and its rent) and
    /// can buy back into the same PDA without re-paying for it; `redeem` is what
    /// finally closes it and returns the rent. Closing here would also mean an
    /// `init_if_needed` on the buy side racing an account close in the same
    /// slot, which is a failure mode with no upside.
    ///
    /// The owner check is spelled out rather than written `has_one = owner`
    /// because the signer field is `seller`, not `owner`; `has_one` matches on
    /// the *field name* in this struct.
    #[account(
        mut,
        has_one = market,
        seeds = [POSITION_SEED, market.key().as_ref(), seller.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == seller.key() @ GreekBetError::Unauthorized,
    )]
    pub position: Account<'info, UserPosition>,

    /// The market's collateral vault — the source of the payout. Pinned to the
    /// pubkey the market stored at creation, so a look-alike token account
    /// cannot be substituted.
    #[account(
        mut,
        address = market.vault @ GreekBetError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Where the proceeds land. Validated against the market's own
    /// `collateral_mint` (D3), never against a hardcoded mint.
    #[account(
        mut,
        constraint = seller_token_account.mint == market.collateral_mint
            @ GreekBetError::InvalidMint,
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Sell `share_amount` of `outcome` back to the market.
///
/// # Slippage semantics: `min_usdc_out`
///
/// The fewest collateral base units the seller will accept for their
/// `share_amount`; below that the instruction fails with
/// [`GreekBetError::SlippageExceeded`] having moved nothing.
///
/// This is the same shape as [`buy_shares`](super::buy_shares)'s
/// `min_shares_out`: **in both instructions the limit is the minimum of the
/// thing the caller receives.**
/// The caller fixes their input exactly and floors their output, so the worst
/// effective price is `min_usdc_out / share_amount` on this side and
/// `usdc_amount / min_shares_out` on the other — computable client-side with no
/// knowledge of the curve, and with no marginal-versus-average price ambiguity.
///
/// Passing `0` disables the check but does not permit a zero-proceeds sell —
/// see below.
///
/// # Zero-proceeds sells are rejected (ticket item 6a, option (b))
///
/// **A deliberate divergence from the reference oracle; T09's parity test must
/// expect it.**
///
/// At extreme skew (`(q_min − q_max)/b < −138`) the exact value of a trade falls
/// below `1e-60` and floors to zero. On this side that means a seller handing
/// over real shares and receiving **nothing** — the mirror of the free option
/// `buy_shares` refuses. The oracle returns `0` and lets it through; this
/// program rejects it with [`GreekBetError::ZeroCostTrade`], because burning a
/// position for no collateral is never what a caller meant, and a holder of
/// worthless shares still has a clean exit: `redeem` pays them zero *and*
/// returns their rent once the market resolves.
///
/// `share_amount == 0` is caught by the same guard, since it always prices to
/// zero proceeds.
///
/// # Ordering
///
/// Tradeability, sufficiency, the quote, slippage and vault solvency are all
/// checked before the first byte of state is written; the position is debited
/// and `q` decremented before the CPI, exactly as `redeem.rs` does it. There is
/// no failure path that leaves partial state.
pub fn sell_shares_handler(
    ctx: Context<SellShares>,
    outcome: Outcome,
    share_amount: u64,
    min_usdc_out: u64,
) -> Result<()> {
    // ---- 1. is the market tradeable at all? ------------------------------
    //
    // Identical to `buy_shares`: status *and* clock, both reported as
    // `MarketNotOpen`. `close_market` is a bookkeeping crank, not the security
    // boundary — an uncranked market past `close_time` must not trade in either
    // direction.
    let now = Clock::get()?.unix_timestamp;
    require!(ctx.accounts.market.is_open(), GreekBetError::MarketNotOpen);
    require!(
        now < ctx.accounts.market.close_time,
        GreekBetError::MarketNotOpen
    );

    // ---- 2. the position must actually hold what is being sold -----------
    //
    // Checked against the *position*, not against `q`. `q` is the whole
    // market's supply; letting it authorise a sell would let one trader unwind
    // another's exposure.
    let position_yes_before = ctx.accounts.position.yes_shares;
    let position_no_before = ctx.accounts.position.no_shares;
    let held = match outcome {
        Outcome::Yes => position_yes_before,
        Outcome::No => position_no_before,
    };
    require!(held >= share_amount, GreekBetError::InsufficientShares);

    // ---- 3. quote --------------------------------------------------------
    //
    // Floored by the crate, in the vault's favour. Nothing is re-rounded here.
    let (q_yes_before, q_no_before) = ctx.accounts.market.q();
    let b = ctx.accounts.market.b;
    let proceeds = lmsr::sell_return(
        q_yes_before,
        q_no_before,
        b,
        lmsr::Outcome::from(outcome),
        share_amount,
    )
    .or_program_err()?;

    // Shares in, nothing out — see the doc comment. Also catches
    // `share_amount == 0`.
    require!(proceeds > 0, GreekBetError::ZeroCostTrade);

    // ---- 4. slippage, on-chain (plan §2.3) ------------------------------
    enforce_min_usdc_out(proceeds, min_usdc_out)?;

    // ---- 5. new state, computed before anything is written ---------------
    let (q_yes_after, q_no_after) = match outcome {
        Outcome::Yes => (q_after_sell(q_yes_before, share_amount)?, q_no_before),
        Outcome::No => (q_yes_before, q_after_sell(q_no_before, share_amount)?),
    };
    let (position_yes_after, position_no_after) = match outcome {
        Outcome::Yes => (
            position_yes_before
                .checked_sub(share_amount)
                .ok_or(GreekBetError::InsufficientShares)?,
            position_no_before,
        ),
        Outcome::No => (
            position_yes_before,
            position_no_before
                .checked_sub(share_amount)
                .ok_or(GreekBetError::InsufficientShares)?,
        ),
    };

    // ---- 6. solvency, before the vault is asked for anything -------------
    //
    // LMSR makes this unreachable: `create_market` deposits `b·ln 2` up front
    // and `C(q)` never falls below `max(q_yes, q_no)`, so the vault provably
    // covers every sell. Asserting it anyway turns an accounting bug elsewhere
    // into a loud, attributable failure here instead of an `insufficient funds`
    // from the token program.
    require!(
        ctx.accounts.vault.amount >= proceeds,
        GreekBetError::VaultInsolvent
    );

    // ---- 7. state, then CPI ---------------------------------------------
    let market_key = ctx.accounts.market.key();
    let seller_key = ctx.accounts.seller.key();
    {
        let market = &mut ctx.accounts.market;
        market.q_yes = q_yes_after;
        market.q_no = q_no_after;

        let position = &mut ctx.accounts.position;
        position.yes_shares = position_yes_after;
        position.no_shares = position_no_after;
    }

    {
        let market = &ctx.accounts.market;

        // The vault's authority is the *market* PDA (plan §2.1, T06), so the
        // market's own seeds sign the withdrawal. `market.vault_bump` is
        // deliberately NOT used: it is the bump of the vault PDA's own
        // derivation and would derive the wrong signer.
        let market_bump = [market.bump];
        let market_seeds: &[&[u8]] = &[
            MARKET_SEED,
            market.creator.as_ref(),
            market.question_hash.as_ref(),
            &market_bump,
        ];
        let signer_seeds = &[market_seeds];

        // Anchor 1.2.0's `CpiContext::new_with_signer` takes the program
        // **`Pubkey`**, not an `AccountInfo`.
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.seller_token_account.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer_seeds,
            ),
            proceeds,
        )?;
    }

    // ---- 8. event --------------------------------------------------------
    let price_yes_after = lmsr::price_yes(q_yes_after, q_no_after, b).or_program_err()?;

    emit!(SharesSold {
        market: market_key,
        seller: seller_key,
        outcome,
        shares_in: share_amount,
        collateral_out: proceeds,
        avg_price_received: avg_price(proceeds, share_amount)?,
        q_yes_before,
        q_no_before,
        q_yes_after,
        q_no_after,
        price_yes_after,
        position_yes_shares: position_yes_after,
        position_no_shares: position_no_after,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Pure helpers — the arithmetic, split out so it can be unit-tested off-chain
// ---------------------------------------------------------------------------

/// `q_side − share_amount`.
///
/// Under-running `q` is impossible if the position accounting is right (the
/// positions of a market sum to its `q`), so this is a second, independent
/// guard on the same invariant the position check enforces. It reports
/// [`GreekBetError::InsufficientShares`] rather than
/// [`GreekBetError::MathOverflow`], because the condition is "you are trying to
/// sell more than exists", not an arithmetic accident.
#[inline]
fn q_after_sell(q_side: u64, share_amount: u64) -> Result<u64> {
    q_side
        .checked_sub(share_amount)
        .ok_or_else(|| error!(GreekBetError::InsufficientShares))
}

/// On-chain slippage: the seller receives at least what they asked for.
#[inline]
fn enforce_min_usdc_out(proceeds: u64, min_usdc_out: u64) -> Result<()> {
    require!(proceeds >= min_usdc_out, GreekBetError::SlippageExceeded);
    Ok(())
}

/// Effective price received, `UNIT`-scaled (`500_000` == `0.5`), floored.
/// Informational, for the event only.
///
/// `shares` is non-zero by the time this is reached, but the guard is kept
/// rather than assumed: a division by zero is a panic, and this program has none
/// outside `#[cfg(test)]`.
#[inline]
fn avg_price(collateral: u64, shares: u64) -> Result<u64> {
    require!(shares > 0, GreekBetError::ZeroCostTrade);
    let scaled = u128::from(collateral)
        .checked_mul(u128::from(lmsr::UNIT))
        .ok_or(GreekBetError::MathOverflow)?;
    u64::try_from(scaled / u128::from(shares)).map_err(|_| error!(GreekBetError::MathOverflow))
}

/// Emitted on every successful `sell_shares`.
///
/// The exact mirror of
/// [`SharesBought`](super::buy_shares::SharesBought), so an indexer can treat
/// the two as one stream of state transitions.
#[event]
pub struct SharesSold {
    /// The market traded against.
    pub market: Pubkey,
    /// Who sold, and whose position was debited.
    pub seller: Pubkey,
    /// Which side was sold.
    pub outcome: Outcome,
    /// Share base units burned from the position and removed from `q`.
    pub shares_in: u64,
    /// Collateral base units moved out of the vault, from
    /// [`lmsr::sell_return`] (floored).
    pub collateral_out: u64,
    /// `collateral_out · UNIT / shares_in`, floored — the effective price
    /// received per share, on the same scale as [`Self::price_yes_after`].
    pub avg_price_received: u64,
    /// `market.q_yes` immediately before the trade.
    pub q_yes_before: u64,
    /// `market.q_no` immediately before the trade.
    pub q_no_before: u64,
    /// `market.q_yes` immediately after the trade.
    pub q_yes_after: u64,
    /// `market.q_no` immediately after the trade.
    pub q_no_after: u64,
    /// Marginal YES price after the trade, `UNIT`-scaled. The NO price is
    /// `UNIT − price_yes_after`, exactly.
    pub price_yes_after: u64,
    /// The seller's YES holding after the trade.
    pub position_yes_shares: u64,
    /// The seller's NO holding after the trade.
    pub position_no_shares: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code_of(e: &Error) -> u32 {
        match e {
            Error::AnchorError(inner) => inner.error_code_number,
            Error::ProgramError(_) => panic!("expected an AnchorError, got a ProgramError"),
        }
    }

    fn assert_is(e: Error, want: GreekBetError) {
        assert_eq!(
            code_of(&e),
            anchor_lang::error::ERROR_CODE_OFFSET + want as u32,
        );
    }

    // ---- q accounting ----------------------------------------------------

    #[test]
    fn q_after_sell_is_a_plain_subtraction() {
        assert_eq!(q_after_sell(10, 4).unwrap(), 6);
        assert_eq!(q_after_sell(10, 10).unwrap(), 0);
        assert_eq!(q_after_sell(0, 0).unwrap(), 0);
        assert_eq!(q_after_sell(lmsr::MAX_Q, 1).unwrap(), lmsr::MAX_Q - 1);
    }

    /// Selling more than exists is a supply error, not an arithmetic one — the
    /// distinction is what lets a T09 negative test assert the right cause.
    #[test]
    fn q_after_sell_under_run_is_insufficient_shares() {
        assert_is(
            q_after_sell(10, 11).unwrap_err(),
            GreekBetError::InsufficientShares,
        );
        assert_is(
            q_after_sell(0, 1).unwrap_err(),
            GreekBetError::InsufficientShares,
        );
        assert_is(
            q_after_sell(1, u64::MAX).unwrap_err(),
            GreekBetError::InsufficientShares,
        );
    }

    // ---- slippage --------------------------------------------------------

    #[test]
    fn min_usdc_out_is_inclusive() {
        assert!(enforce_min_usdc_out(100, 100).is_ok());
        assert!(enforce_min_usdc_out(101, 100).is_ok());
        assert_is(
            enforce_min_usdc_out(99, 100).unwrap_err(),
            GreekBetError::SlippageExceeded,
        );
    }

    #[test]
    fn a_zero_limit_disables_the_check() {
        assert!(enforce_min_usdc_out(0, 0).is_ok());
        assert!(enforce_min_usdc_out(u64::MAX, 0).is_ok());
    }

    // ---- rounding: proceeds must never round up --------------------------

    #[test]
    fn avg_price_rounds_down() {
        assert_eq!(avg_price(1, 3).unwrap(), 333_333);
        assert_eq!(avg_price(2, 3).unwrap(), 666_666);
        assert_eq!(avg_price(1_000_000, 2_000_000).unwrap(), lmsr::UNIT / 2);
    }

    #[test]
    fn avg_price_refuses_a_zero_denominator_instead_of_panicking() {
        assert_is(avg_price(1, 0).unwrap_err(), GreekBetError::ZeroCostTrade);
    }

    /// The vault-drain vector: a buy immediately followed by a sell of the same
    /// size must never return more than it took. `buy_cost` ceils and
    /// `sell_return` floors, which is what guarantees it — and this file must
    /// not undo that by re-rounding the crate's output.
    ///
    /// Checked over the whole legal `b` range at a spread of states, including
    /// both `B_MIN` and `B_MAX`.
    #[test]
    fn a_buy_then_sell_round_trip_never_profits() {
        let states: &[(u64, u64)] = &[
            (0, 0),
            (1, 0),
            (1_000_000, 1_000_000),
            (50_000_000, 0),
            (0, 50_000_000),
            (10_000_000_000, 3_000_000),
            (999_999_999_999_999, 0),
        ];
        let sizes: &[u64] = &[1, 7, 1_000_000, 10_000_000, 1_000_000_000];

        for b in [lmsr::B_MIN, 100_000_000, 1_000_000_000, lmsr::B_MAX] {
            for &(q_yes, q_no) in states {
                for outcome in [lmsr::Outcome::Yes, lmsr::Outcome::No] {
                    for &n in sizes {
                        let paid = match lmsr::buy_cost(q_yes, q_no, b, outcome, n) {
                            Ok(v) => v,
                            // Past MAX_Q: not a round trip this market allows.
                            Err(_) => continue,
                        };
                        let (ny, nn) = match outcome {
                            lmsr::Outcome::Yes => (q_yes + n, q_no),
                            lmsr::Outcome::No => (q_yes, q_no + n),
                        };
                        let back = lmsr::sell_return(ny, nn, b, outcome, n).unwrap();
                        assert!(
                            back <= paid,
                            "round trip profited: b={b} q=({q_yes},{q_no}) \
                             {outcome:?} n={n} paid={paid} back={back}",
                        );
                    }
                }
            }
        }
    }

    /// The zero-proceeds sell this instruction refuses: a holder of the
    /// near-certain loser unwinding at extreme skew gets floored to nothing.
    /// The crate returns `0` (correctly); the handler turns that into
    /// `ZeroCostTrade` rather than burning the position for free.
    #[test]
    fn a_deep_skew_sell_can_price_to_zero() {
        // NO is worthless: YES is pinned at the cap with the tightest b.
        let (q_yes, q_no, b) = (lmsr::MAX_Q, 1_000_000u64, lmsr::B_MIN);
        let proceeds = lmsr::sell_return(q_yes, q_no, b, lmsr::Outcome::No, 1_000_000).unwrap();
        assert_eq!(
            proceeds, 0,
            "expected the deep-skew sell to floor to zero, got {proceeds}",
        );
        // Which is what the handler rejects; `min_usdc_out` alone would not,
        // since a caller passing 0 would sail through.
        assert!(enforce_min_usdc_out(proceeds, 0).is_ok());
    }

    /// `share_amount == 0` is a zero-proceeds sell by construction, so the one
    /// guard covers both degenerate cases.
    #[test]
    fn selling_nothing_prices_to_zero() {
        for b in [lmsr::B_MIN, lmsr::B_MAX] {
            assert_eq!(
                lmsr::sell_return(5_000_000, 3_000_000, b, lmsr::Outcome::Yes, 0).unwrap(),
                0
            );
        }
    }
}
