//! `buy_shares` — **owned by T07.** The core trade path, and the one where a
//! bug costs money.
//!
//! The buyer names a **collateral amount** and receives however many shares that
//! amount buys. They never name a share count, so this instruction is the
//! *inverse* direction of the LMSR cost function: it calls
//! [`lmsr::shares_for_cost`] and charges exactly what the caller supplied.
//!
//! # The one thing to understand about this instruction
//!
//! **It charges `usdc_amount` verbatim. It does not re-price the quote.**
//!
//! The obvious implementation — quote `n = shares_for_cost(state, c)`, then
//! charge `buy_cost(state, n)` and assert the charge is `<= c` — is *wrong on
//! real inputs*, and T04 measured exactly how wrong.
//!
//! `buy_cost(state, shares_for_cost(state, c)) <= c` is a theorem in exact
//! arithmetic (`shares_for_cost` floors, so `n <= d`, so the exact cost of `n`
//! is `<= c`, and `ceil` of something `<= c` is `<= c`). Both `lmsr.rs` and
//! `reference/README.md` state it unqualified. **In Q64.64 it is false.** It
//! fails by exactly `+1` base unit on roughly **1 in 10,000** random
//! `(state, budget)` pairs, at every `b` decade, down to skew 10.5. Three
//! counterexamples are pinned in `crates/lmsr/tests/properties.rs`; the shallowest
//! is
//!
//! ```text
//! q_yes = 48, q_no = 10_527_565_366_593, b = 999_863_744_567, buy Yes with 2_056_658
//!   -> shares_for_cost = 74_075_393_532
//!   -> exact ΔC        = 2056657.99999997722   (so the correct ceil is 2_056_658)
//!   -> Rust buy_cost   = 2_056_659             (+1, i.e. one base unit over budget)
//! ```
//!
//! The cause is inherent, not a bug: `b·ln(z)` carries an absolute error of
//! about `b · 2^-64 · k`, which is **`b`-scaled, not skew-scaled** (`≈ 2.7e-8`
//! at `b = B_MAX`). Whenever the exact `ΔC` lands that close *below* an integer,
//! `ceil` flips to the wrong side. It is always `+1` in the *protocol's* favour,
//! so solvency is untouched — but an `assert!(cost <= usdc_amount)` written
//! against it would revert a legitimate trade about once in ten thousand.
//!
//! Charging `usdc_amount` sidesteps it entirely, is what
//! `reference/vectors/trades.json`'s `buy_with_collateral` ledger does, and has
//! no such failure mode. [`lmsr::buy_cost`] is therefore **never called here**.
//!
//! Relatedly: `EXACT_SKEW_LIMIT` describes T04's fixed 3,988-vector corpus, not
//! the function. Nothing in this file may assume exactness below any skew.
//!
//! # LMSR calls, and why there are only two
//!
//! T04 measured the maths of a `buy_shares`-shaped sequence at **64,229 CU**
//! (32% of the 200,000 default), with a worst-column upper bound of 86,319, and
//! `compute_budget.rs` asserts a **100,000 CU ceiling** on the LMSR maths of any
//! one instruction. Two `shares_for_cost`-class calls fit; three do not.
//!
//! This handler makes exactly two heavy calls:
//!
//! | call | worst-column CU | why |
//! |---|---:|---|
//! | [`lmsr::shares_for_cost`] | 48,272 | the quote — the whole instruction |
//! | [`lmsr::price_yes`] | 12,315 | the post-trade marginal price, for the event |
//!
//! **60,587 CU** worst-case bound, against a budget model that had allowed
//! 86,319 for this instruction — dropping `buy_cost` bought back 25,732 CU.
//! [`lmsr::validate_q`] is a `const fn` comparison and costs nothing.
//!
//! # Rounding
//!
//! Nothing is rounded or rescaled here. `shares_for_cost` floors the share count
//! (in the protocol's favour) and the charge is the caller's own integer. Adding
//! any arithmetic on top of the crate's output would break the exact-match
//! requirement T09 asserts (plan §4.2).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::{MARKET_SEED, POSITION_SEED};
use crate::errors::{GreekBetError, LmsrResultExt};
use crate::state::{Market, Outcome, UserPosition};

/// Accounts for [`buy_shares_handler`].
///
/// Every token account is pinned to something the *market* stored, never to a
/// program constant (D3): the vault by `market.vault`, the buyer's account by
/// `market.collateral_mint`. Both PDAs re-derive from their canonical seeds, so
/// a `Market`- or `UserPosition`-shaped account of this program that is not at
/// its own address cannot be substituted.
#[derive(Accounts)]
pub struct BuyShares<'info> {
    /// The buyer. Signs the collateral transfer and pays rent the first time
    /// they trade in this market (`init_if_needed` on `position`), hence `mut`.
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// The market being traded. `mut` because `q_yes` / `q_no` move.
    ///
    /// The seeds constraint mirrors `close_market`: it re-derives the market
    /// from the `creator` and `question_hash` it stores, using the stored bump,
    /// so this is a `create_program_address` check rather than a search.
    #[account(
        mut,
        seeds = [MARKET_SEED, market.creator.as_ref(), market.question_hash.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// The buyer's position in this market, created on first purchase.
    ///
    /// # Why `has_one` is absent and the seeds are the whole check
    ///
    /// `init_if_needed` runs the account's other constraints *after* a fresh
    /// account has been zero-initialised, so `has_one = market` would fail on
    /// the very first buy (`Pubkey::default() != market.key()`). The seeds
    /// constraint is strictly stronger anyway: it derives the address from
    /// `market.key()` and `buyer.key()`, so no other account can be passed here
    /// at all, whether it exists yet or not. The handler then (re-)writes
    /// `market`, `owner` and `bump` unconditionally, which is idempotent for an
    /// existing position and initialisation for a new one.
    #[account(
        init_if_needed,
        payer = buyer,
        space = UserPosition::LEN,
        seeds = [POSITION_SEED, market.key().as_ref(), buyer.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, UserPosition>,

    /// The market's collateral vault — the destination of the deposit. Pinned
    /// to the pubkey the market stored at creation.
    #[account(
        mut,
        address = market.vault @ GreekBetError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Where the collateral comes from. Validated against the market's own
    /// `collateral_mint` (D3) and required to belong to the signer, so a buyer
    /// cannot spend a third party's account even if that account has delegated
    /// authority elsewhere.
    #[account(
        mut,
        constraint = buyer_token_account.mint == market.collateral_mint
            @ GreekBetError::InvalidMint,
        constraint = buyer_token_account.owner == buyer.key()
            @ GreekBetError::Unauthorized,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Buy `outcome` shares by depositing exactly `usdc_amount` of collateral.
///
/// # Slippage semantics: `min_shares_out`
///
/// **The third argument is a minimum output, not a price tolerance.** It is the
/// fewest share base units the buyer will accept in exchange for their
/// `usdc_amount`; fewer than that and the instruction fails with
/// [`GreekBetError::SlippageExceeded`] having moved nothing.
///
/// It is declared as `max_slippage` in `lib.rs`'s `#[program]` signature (and
/// therefore in the IDL) because that file belongs to T05 and this ticket may
/// not edit it. The name is the only thing that survives from the original
/// spelling; the meaning is `min_shares_out`. See this ticket's report for the
/// recommendation to rename it.
///
/// Why a share-denominated limit rather than a price one:
///
/// * **It is unambiguous.** A "max price" limit has to say *which* price —
///   marginal before the trade, marginal after, or the average actually paid —
///   and those three differ by exactly the trade's own impact, which is the
///   quantity being protected against. Clients get that wrong.
/// * **It needs no extra maths, on-chain or off.** The comparison is against
///   the number `shares_for_cost` already returned; no division, no second LMSR
///   call, no rounding decision that could favour the user.
/// * **It composes with the charge.** The buyer fixes both sides of the trade:
///   they spend exactly `usdc_amount` and receive at least `min_shares_out`, so
///   the worst effective price they can pay is `usdc_amount / min_shares_out` —
///   a number they can compute themselves with no knowledge of the curve.
/// * It mirrors [`sell_shares`](super::sell_shares)'s `min_usdc_out` exactly:
///   in both instructions the argument is *the least of the thing you receive*.
///
/// Passing `0` disables the check. It does **not** permit a zero-output trade —
/// see below.
///
/// # Zero-cost / zero-share trades are rejected (ticket item 6a, option (b))
///
/// **This is a deliberate divergence from the reference oracle and T09's parity
/// test must expect it.**
///
/// T01 established that at extreme skew (`(q_min − q_max)/b < −138`) the exact
/// cost of a trade falls below `1e-60` and correctly rounds to zero, so shares
/// of a near-certain loser can be acquired for no collateral. The oracle does
/// not floor that, and the vault stays solvent either way, because a payout is
/// bounded by `max(q_yes, q_no)` and such trades do not raise it. It is
/// nonetheless a **free option**: zero cost, non-zero payoff if the long shot
/// lands.
///
/// This program refuses degenerate trades in both directions, with
/// [`GreekBetError::ZeroCostTrade`]:
///
/// * `usdc_amount == 0` — the free option in its literal form. Rejected before
///   any LMSR call.
/// * `shares == 0` — collateral in, nothing out. The mirror image, and the one
///   a real user could hit by accident with a `min_shares_out` of `0`.
///
/// # What these guards do *not* cover
///
/// The collateral-denominated formulation makes the *classic* free option
/// structurally unreachable: `shares_for_cost(state, 0)` is `0`, so a
/// zero-collateral buy was never going to yield shares in the first place. The
/// guards above close the degenerate cases, not the economics.
///
/// What remains is a **near**-free option: at extreme skew one base unit of
/// collateral buys an enormous number of near-worthless shares (measured at
/// 999,999,838,819,043 shares for `1` at `q = (MAX_Q, 0)`, `b = B_MIN` — see
/// `a_one_base_unit_buy_at_extreme_skew_stays_under_the_cap`). That is priced
/// correctly and the vault stays solvent, because a payout is bounded by
/// `max(q_yes, q_no)` and buying the light side moves it *towards* the heavy
/// side rather than above it — which is also why such a trade does **not** trip
/// `MAX_Q`. Reaching that skew requires someone to have already paid in
/// proportionally, so it is not a cheap attack; it is accepted knowingly, as
/// T01 concluded.
///
/// # Ordering
///
/// Everything is computed and validated — tradeability, the quote, slippage,
/// `MAX_Q`, the new position — *before* the first byte of state is written and
/// well before the CPI. There is no failure path that leaves partial state.
pub fn buy_shares_handler(
    ctx: Context<BuyShares>,
    outcome: Outcome,
    usdc_amount: u64,
    min_shares_out: u64,
) -> Result<()> {
    // ---- 1. is the market tradeable at all? ------------------------------
    //
    // Status *and* clock. `close_market` is a permissionless bookkeeping crank,
    // not the security boundary: a market past `close_time` that nobody has
    // cranked is still `Open` on the flag alone, and must not trade. Both
    // failures report `MarketNotOpen` — from a trader's point of view they are
    // the same condition, and `CloseTimeNotReached` means the opposite thing
    // (a crank that arrived too early).
    let now = Clock::get()?.unix_timestamp;
    require!(ctx.accounts.market.is_open(), GreekBetError::MarketNotOpen);
    require!(
        now < ctx.accounts.market.close_time,
        GreekBetError::MarketNotOpen
    );

    // ---- 2. reject the degenerate trade before spending any compute ------
    require!(usdc_amount > 0, GreekBetError::ZeroCostTrade);

    // ---- 3. quote --------------------------------------------------------
    //
    // The only expensive LMSR call in this instruction. `shares_for_cost`
    // floors, so the share count is already in the protocol's favour; nothing
    // is rounded on top of it.
    let (q_yes_before, q_no_before) = ctx.accounts.market.q();
    let b = ctx.accounts.market.b;
    let shares = lmsr::shares_for_cost(
        q_yes_before,
        q_no_before,
        b,
        lmsr::Outcome::from(outcome),
        usdc_amount,
    )
    .or_program_err()?;

    // Collateral in, nothing out — see the doc comment.
    require!(shares > 0, GreekBetError::ZeroCostTrade);

    // ---- 4. slippage, on-chain (plan §2.3) ------------------------------
    enforce_min_shares_out(shares, min_shares_out)?;

    // ---- 5. MAX_Q --------------------------------------------------------
    //
    // `shares_for_cost` deliberately returns the unclamped mathematical answer;
    // T01 found 55 vector cases that legitimately exceed the cap, so this is a
    // reachable path.
    let (q_yes_after, q_no_after) = match outcome {
        Outcome::Yes => (q_after_buy(q_yes_before, shares)?, q_no_before),
        Outcome::No => (q_yes_before, q_after_buy(q_no_before, shares)?),
    };

    // ---- 6. the new position, computed before anything is written --------
    let position_yes_before = ctx.accounts.position.yes_shares;
    let position_no_before = ctx.accounts.position.no_shares;
    let (position_yes_after, position_no_after) = match outcome {
        Outcome::Yes => (
            position_yes_before
                .checked_add(shares)
                .ok_or(GreekBetError::MathOverflow)?,
            position_no_before,
        ),
        Outcome::No => (
            position_yes_before,
            position_no_before
                .checked_add(shares)
                .ok_or(GreekBetError::MathOverflow)?,
        ),
    };

    // ---- 7. state, then CPI ---------------------------------------------
    //
    // Every check above has passed; from here nothing can fail except the token
    // transfer itself, which aborts the whole instruction and discards these
    // writes (Anchor only persists account data at `exit()`, on success).
    let market_key = ctx.accounts.market.key();
    let buyer_key = ctx.accounts.buyer.key();
    let position_bump = ctx.bumps.position;
    {
        let market = &mut ctx.accounts.market;
        market.q_yes = q_yes_after;
        market.q_no = q_no_after;

        let position = &mut ctx.accounts.position;
        // Idempotent for an existing position; initialisation for a new one.
        // `init_if_needed` cannot leave these unset, because the seeds
        // constraint already proved this account *is* (market, buyer)'s.
        position.market = market_key;
        position.owner = buyer_key;
        position.bump = position_bump;
        position.yes_shares = position_yes_after;
        position.no_shares = position_no_after;
    }

    // Charge exactly what the buyer supplied. No re-pricing — see the module
    // docs for the `buy_cost` `+1` finding this avoids.
    //
    // Anchor 1.2.0's `CpiContext::new` takes the program **`Pubkey`**, not an
    // `AccountInfo`; `.to_account_info()` here is a type error.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.buyer_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        usdc_amount,
    )?;

    // ---- 8. event --------------------------------------------------------
    //
    // The second and last LMSR call: the marginal YES price *after* the trade.
    // The pre-trade price is recoverable by an indexer from `q_*_before`, so it
    // is not worth a third call against the compute ceiling.
    let price_yes_after = lmsr::price_yes(q_yes_after, q_no_after, b).or_program_err()?;

    emit!(SharesBought {
        market: market_key,
        buyer: buyer_key,
        outcome,
        collateral_in: usdc_amount,
        shares_out: shares,
        avg_price_paid: avg_price(usdc_amount, shares)?,
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

/// `q_side + shares`, refusing to exceed [`lmsr::MAX_Q`].
///
/// # Why the addition is done in `u128`
///
/// So that an oversized buy always reports [`GreekBetError::QOutOfRange`] and
/// never [`GreekBetError::MathOverflow`]. `shares_for_cost` is unclamped and can
/// legitimately return a number near `2^63`, and `q_side + shares` in `u64`
/// would then wrap-check *before* the cap check and surface the wrong error —
/// which is exactly the sort of thing that makes a T09 negative test pass for
/// the wrong reason. `u128` addition of two `u64`s cannot overflow; the
/// `checked_add` is there so a future widening of either type cannot silently
/// remove the guarantee.
#[inline]
fn q_after_buy(q_side: u64, shares: u64) -> Result<u64> {
    let new_q = u128::from(q_side)
        .checked_add(u128::from(shares))
        .ok_or(GreekBetError::MathOverflow)?;
    require!(new_q <= u128::from(lmsr::MAX_Q), GreekBetError::QOutOfRange);
    u64::try_from(new_q).map_err(|_| error!(GreekBetError::MathOverflow))
}

/// On-chain slippage: the buyer receives at least what they asked for.
#[inline]
fn enforce_min_shares_out(shares: u64, min_shares_out: u64) -> Result<()> {
    require!(shares >= min_shares_out, GreekBetError::SlippageExceeded);
    Ok(())
}

/// Effective price actually paid, in the same `UNIT`-scaled form as
/// [`lmsr::price_yes`] (`500_000` == `0.5`). Informational, for the event only.
///
/// Floored, so it never overstates what the trade cost. `shares` is non-zero by
/// the time this is reached (`ZeroCostTrade` fires otherwise), but the guard is
/// kept rather than assumed: a division by zero is a panic, and this program has
/// none outside `#[cfg(test)]`.
#[inline]
fn avg_price(collateral: u64, shares: u64) -> Result<u64> {
    require!(shares > 0, GreekBetError::ZeroCostTrade);
    let scaled = u128::from(collateral)
        .checked_mul(u128::from(lmsr::UNIT))
        .ok_or(GreekBetError::MathOverflow)?;
    u64::try_from(scaled / u128::from(shares)).map_err(|_| error!(GreekBetError::MathOverflow))
}

/// Emitted on every successful `buy_shares`.
///
/// Carries the full pre- and post-trade LMSR state so an indexer can reprice the
/// market at any point in its history without replaying account snapshots, and
/// both a marginal and an effective price so the trade's impact is visible
/// directly.
#[event]
pub struct SharesBought {
    /// The market traded against.
    pub market: Pubkey,
    /// Who bought, and who owns the credited position.
    pub buyer: Pubkey,
    /// Which side was bought.
    pub outcome: Outcome,
    /// Collateral base units moved into the vault. **Exactly the
    /// `usdc_amount` argument** — this instruction never re-prices the quote.
    pub collateral_in: u64,
    /// Share base units credited, from [`lmsr::shares_for_cost`] (floored).
    pub shares_out: u64,
    /// `collateral_in · UNIT / shares_out`, floored — the effective price paid
    /// per share, on the same scale as [`Self::price_yes_after`].
    pub avg_price_paid: u64,
    /// `market.q_yes` immediately before the trade.
    pub q_yes_before: u64,
    /// `market.q_no` immediately before the trade.
    pub q_no_before: u64,
    /// `market.q_yes` immediately after the trade.
    pub q_yes_after: u64,
    /// `market.q_no` immediately after the trade.
    pub q_no_after: u64,
    /// Marginal YES price after the trade, `UNIT`-scaled (`500_000` == `0.5`).
    /// The NO price is `UNIT − price_yes_after`, exactly.
    pub price_yes_after: u64,
    /// The buyer's YES holding after the trade.
    pub position_yes_shares: u64,
    /// The buyer's NO holding after the trade.
    pub position_no_shares: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Anchor's custom error codes start at 6000, in `GreekBetError`
    /// declaration order.
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

    // ---- MAX_Q -----------------------------------------------------------

    /// The cap is the *program's* job: `shares_for_cost` is documented as
    /// unclamped, and T01 found 55 vector cases that exceed it.
    #[test]
    fn q_after_buy_accepts_exactly_max_q() {
        assert_eq!(q_after_buy(lmsr::MAX_Q, 0).unwrap(), lmsr::MAX_Q);
        assert_eq!(q_after_buy(lmsr::MAX_Q - 1, 1).unwrap(), lmsr::MAX_Q);
        assert_eq!(q_after_buy(0, lmsr::MAX_Q).unwrap(), lmsr::MAX_Q);
    }

    #[test]
    fn q_after_buy_rejects_one_past_max_q() {
        assert_is(
            q_after_buy(lmsr::MAX_Q, 1).unwrap_err(),
            GreekBetError::QOutOfRange,
        );
        assert_is(
            q_after_buy(lmsr::MAX_Q - 1, 2).unwrap_err(),
            GreekBetError::QOutOfRange,
        );
    }

    /// The reason the addition is widened to `u128`: an unclamped
    /// `shares_for_cost` answer near `2^63` must still report `QOutOfRange`,
    /// not `MathOverflow`, or a negative test would pass for the wrong reason.
    #[test]
    fn an_absurd_share_count_is_q_out_of_range_not_overflow() {
        for shares in [u64::MAX, u64::MAX / 2, 1u64 << 63, lmsr::MAX_Q + 1] {
            assert_is(
                q_after_buy(lmsr::MAX_Q, shares).unwrap_err(),
                GreekBetError::QOutOfRange,
            );
            assert_is(
                q_after_buy(0, shares).unwrap_err(),
                GreekBetError::QOutOfRange,
            );
        }
    }

    // ---- slippage --------------------------------------------------------

    #[test]
    fn min_shares_out_is_inclusive() {
        assert!(enforce_min_shares_out(100, 100).is_ok());
        assert!(enforce_min_shares_out(101, 100).is_ok());
        assert_is(
            enforce_min_shares_out(99, 100).unwrap_err(),
            GreekBetError::SlippageExceeded,
        );
    }

    /// `0` disables the limit — but never permits a zero-output trade, which
    /// the handler's `ZeroCostTrade` guard rejects independently.
    #[test]
    fn a_zero_limit_disables_the_check() {
        assert!(enforce_min_shares_out(0, 0).is_ok());
        assert!(enforce_min_shares_out(1, 0).is_ok());
        assert!(enforce_min_shares_out(u64::MAX, 0).is_ok());
    }

    // ---- rounding --------------------------------------------------------

    /// The effective price floors, so the event can never overstate what a
    /// trade cost per share.
    #[test]
    fn avg_price_rounds_down() {
        // 3 collateral for 2 shares = 1.5 -> 1_500_000.
        assert_eq!(avg_price(3, 2).unwrap(), 1_500_000);
        // 1 collateral for 3 shares = 0.3333... -> 333_333, not 333_334.
        assert_eq!(avg_price(1, 3).unwrap(), 333_333);
        // A fair coin: 1_000_000 collateral buying 2_000_000 shares is 0.5.
        assert_eq!(avg_price(1_000_000, 2_000_000).unwrap(), lmsr::UNIT / 2);
        // Price 1.0 exactly, the deep-skew limit.
        assert_eq!(avg_price(7, 7).unwrap(), lmsr::UNIT);
    }

    #[test]
    fn avg_price_refuses_a_zero_denominator_instead_of_panicking() {
        assert_is(avg_price(1, 0).unwrap_err(), GreekBetError::ZeroCostTrade);
    }

    // ---- the T04 finding this instruction is designed around -------------

    /// **The reason `buy_cost` is never called in this file.**
    ///
    /// Each of these is a real `(state, budget)` triple from
    /// `crates/lmsr/tests/properties.rs`, verified against
    /// `reference/lmsr_ref.py`. In every one, `shares_for_cost` agrees with the
    /// oracle exactly and `buy_cost` of that answer comes back **one base unit
    /// above the budget** — so the "quote then re-price then assert
    /// `cost <= usdc_amount`" implementation would revert a legitimate trade.
    ///
    /// This test asserts the failure is still there (it is inherent to Q64.64,
    /// and if it ever goes away this file's design comment should be revisited)
    /// *and* that the shipped design is unaffected: the charge is the budget
    /// itself, so there is nothing to compare.
    #[test]
    fn charging_the_budget_survives_the_buy_cost_plus_one_cases() {
        // (q_yes, q_no, b, outcome, budget)
        let cases: &[(u64, u64, u64, lmsr::Outcome, u64)] = &[
            (
                48,
                10_527_565_366_593,
                999_863_744_567,
                lmsr::Outcome::Yes,
                2_056_658,
            ),
            (
                3_725,
                7_914_733_172_682,
                494_421_819_072,
                lmsr::Outcome::Yes,
                88_888,
            ),
            (2_439_435_913_643, 0, 38_240_627_043, lmsr::Outcome::No, 246),
        ];

        for &(q_yes, q_no, b, outcome, budget) in cases {
            let shares = lmsr::shares_for_cost(q_yes, q_no, b, outcome, budget)
                .expect("the quote itself is well defined");
            assert!(shares > 0);

            // The trap. Re-pricing the quote comes back *above* the budget, so
            // `require!(cost <= usdc_amount, SlippageExceeded)` would revert a
            // trade the user can perfectly well afford.
            let repriced = lmsr::buy_cost(q_yes, q_no, b, outcome, shares)
                .expect("the re-price is well defined too");
            assert!(
                repriced > budget,
                "q=({q_yes},{q_no}) b={b} budget={budget}: expected the overshoot, \
                 buy_cost({shares}) = {repriced}",
            );
            // ...and never by more than the one base unit T04 characterised.
            assert_eq!(repriced, budget + 1);

            // What this instruction actually does instead: charge the budget,
            // credit the quote, compare nothing. Nothing here can revert, and
            // the charge equals the *exact-arithmetic* ceil (the oracle's
            // answer), so the vault is not shortchanged either.
            let charged = budget;
            assert_eq!(charged, repriced - 1);
            assert!(enforce_min_shares_out(shares, shares).is_ok());
            assert!(q_after_buy(outcome.select(q_yes, q_no), shares).is_ok());
        }
    }

    /// The pinned counterexample above sits at skew 10.53 — far below the
    /// `EXACT_SKEW_LIMIT`-flavoured intuition that disagreements only happen
    /// past skew 59. Pinned here so nobody re-derives that assumption.
    #[test]
    fn the_shallowest_pinned_case_is_at_a_low_skew() {
        let (q_yes, q_no, b) = (48u64, 10_527_565_366_593u64, 999_863_744_567u64);
        let skew = (q_no - q_yes) as f64 / b as f64;
        assert!(skew < 11.0, "skew was {skew}");
        assert!(skew > 10.0, "skew was {skew}");
    }

    // ---- zero-cost trades ------------------------------------------------

    /// Ticket item 6a, option (b). A zero budget buys nothing from the crate
    /// either, so rejecting it costs no legitimate trade — but the rejection is
    /// explicit rather than implicit, and it is a documented divergence from
    /// the oracle, which returns `0` happily.
    #[test]
    fn a_zero_budget_would_buy_nothing_anyway() {
        let shares = lmsr::shares_for_cost(0, 0, lmsr::B_MIN, lmsr::Outcome::Yes, 0).unwrap();
        assert_eq!(shares, 0);
    }

    /// `shares_for_cost` is unclamped, so the cap has to be enforced here — and
    /// it is genuinely reachable, in two different shapes.
    #[test]
    fn an_unclamped_quote_past_max_q_is_rejected() {
        // (a) The mundane shape: the bought side is already at the cap, so any
        //     buy at all overshoots. Price is pinned at 1, so the shares are
        //     roughly the collateral.
        let shares =
            lmsr::shares_for_cost(lmsr::MAX_Q, 0, lmsr::B_MIN, lmsr::Outcome::Yes, 1_000_000)
                .unwrap();
        assert!(shares > 0);
        assert_is(
            q_after_buy(lmsr::MAX_Q, shares).unwrap_err(),
            GreekBetError::QOutOfRange,
        );

        // (b) The extreme-skew shape: the near-worthless side is so cheap that
        //     1e12 base units (1,000,000 USDC, the whole of `B_MAX`) buys more
        //     than a whole market's worth of it.
        let (q_yes, q_no, b) = (lmsr::MAX_Q, 0u64, lmsr::B_MIN);
        let shares =
            lmsr::shares_for_cost(q_yes, q_no, b, lmsr::Outcome::No, 1_000_000_000_000).unwrap();
        assert!(
            shares > lmsr::MAX_Q,
            "expected an unclamped answer above MAX_Q, got {shares}",
        );
        assert_is(
            q_after_buy(q_no, shares).unwrap_err(),
            GreekBetError::QOutOfRange,
        );
    }

    /// **Why a one-base-unit buy at extreme skew is *not* the `MAX_Q` case**,
    /// recorded because the obvious intuition is wrong and cost this ticket a
    /// test.
    ///
    /// Buying the near-worthless side moves it *towards* the heavy side, and
    /// the heavy side is itself capped at `MAX_Q`. So a small spend on the long
    /// shot buys a colossal number of shares — 999,999,838,819,043 of them for
    /// a single base unit below — but the result lands just *under* the cap by
    /// construction, not over it. Only a spend large enough to push past the
    /// heavy side (case (b) above), or a buy of the side that is already at the
    /// cap (case (a)), actually trips `QOutOfRange`.
    ///
    /// The one-base-unit trade is still very nearly a free option — which is
    /// the honest reason the `usdc_amount == 0` / `shares == 0` guards are not
    /// the whole of the defence, and why `MAX_Q` is enforced separately.
    #[test]
    fn a_one_base_unit_buy_at_extreme_skew_stays_under_the_cap() {
        let (q_yes, q_no, b) = (lmsr::MAX_Q, 0u64, lmsr::B_MIN);
        let shares = lmsr::shares_for_cost(q_yes, q_no, b, lmsr::Outcome::No, 1).unwrap();
        assert_eq!(shares, 999_999_838_819_043);
        // Accepted — and it is priced at 1e-6 USDC per ~1e9 shares.
        let new_q_no = q_after_buy(q_no, shares).unwrap();
        assert!(new_q_no < lmsr::MAX_Q);
        assert_eq!(avg_price(1, shares).unwrap(), 0);
    }
}
