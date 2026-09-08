//! `redeem` — **owned by T08.**
//!
//! Winning shares redeem 1:1 for collateral; losing shares redeem for zero
//! (plan §2.2). Depends only on `resolve_market` having run.
//!
//! # The three properties this file exists to guarantee
//!
//! 1. **Double-redeem is impossible.** Both share counts are zeroed *before*
//!    any CPI, and the [`UserPosition`] PDA is then closed by Anchor on exit.
//!    Either defence alone is sufficient; see `redeem_handler` for the full
//!    argument.
//! 2. **A loser can always close out.** A position holding only losing shares
//!    redeems for zero, is cleared, and returns its rent.
//!    [`GreekBetError::NothingToRedeem`] is reserved for a position that is
//!    *already* empty on both sides.
//! 3. **The vault is never asked for more than it holds.** LMSR guarantees
//!    solvency mathematically, so a failure here is an accounting bug
//!    elsewhere and must surface as [`GreekBetError::VaultInsolvent`] rather
//!    than an opaque SPL-token error.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::{COLLATERAL_DECIMALS, MARKET_SEED, POSITION_SEED};
use crate::errors::GreekBetError;
use crate::state::{Market, Outcome, UserPosition};

/// Collateral base units paid per winning share base unit.
///
/// # The 1:1 assumption, stated so a decimals change cannot silently break it
///
/// Share counts in [`UserPosition`] and collateral amounts in the vault are
/// **the same unit**: 6-decimal base units (`docs/DESIGN_DECISIONS.md` D1's
/// boundary rule, and `lmsr::DECIMALS`). `create_market` (T06) rejects any
/// collateral mint whose `decimals != COLLATERAL_DECIMALS` with
/// [`GreekBetError::InvalidMintDecimals`], so the mint cannot drift at runtime
/// either.
///
/// Concretely: a winning share settles at exactly 1.000000 of collateral, and
/// `1.000000` collateral is `1_000_000` base units, which is also how
/// `1.000000` shares is stored. The scale factor is therefore
/// `10^(collateral_decimals - share_decimals) = 10^0 = 1` — an identity map, not
/// a coincidence.
///
/// If either side's decimals ever change, this constant becomes a real scale
/// factor and the multiplication below becomes a real conversion. The
/// `const _` assertion underneath breaks the build the moment the two decimal
/// counts stop agreeing, so nobody can change one without discovering this.
const SHARES_TO_COLLATERAL_SCALE: u64 = 1;

// If this ever fails, `SHARES_TO_COLLATERAL_SCALE` is a lie: shares and
// collateral no longer share a unit and the payout needs rescaling.
const _: () = assert!(
    COLLATERAL_DECIMALS == lmsr::DECIMALS,
    "shares and collateral must share a decimals count for 1:1 redemption"
);

/// Accounts for [`redeem_handler`].
///
/// Nothing here is a bare `UncheckedAccount`: the position is pinned by its
/// PDA seeds *and* by `has_one`, the vault by the market's stored `vault`
/// pubkey, and the payout destination by the market's stored
/// `collateral_mint` (D3 — the mint is per-market runtime config, never a
/// program constant).
#[derive(Accounts)]
pub struct Redeem<'info> {
    /// The position holder. Must sign, and is the only key that can redeem
    /// this position (`has_one = owner` below). Also the rent recipient when
    /// the position account is closed, hence `mut`.
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The resolved market. Read-only — redemption does not move `q_yes` /
    /// `q_no`; the LMSR state is frozen once the market resolves.
    ///
    /// This account also supplies the seeds that sign the vault withdrawal, so
    /// it must be a real, program-owned `Market` (which `Account<_, Market>`
    /// enforces via owner + discriminator).
    pub market: Account<'info, Market>,

    /// The caller's position in this market.
    ///
    /// `close = owner` returns the rent once redemption succeeds. Anchor runs
    /// the close in `exit()`, i.e. *after* the handler body and after the token
    /// CPI, so it cannot be used to skip the state update — the zeroing in the
    /// handler still happens first.
    #[account(
        mut,
        close = owner,
        has_one = market,
        has_one = owner,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
    )]
    pub position: Account<'info, UserPosition>,

    /// The market's collateral vault. Pinned to the pubkey the market stored
    /// at creation, so a look-alike token account cannot be substituted.
    #[account(
        mut,
        address = market.vault @ GreekBetError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Where the payout lands. Validated against the market's own
    /// `collateral_mint` (D3), never against a hardcoded mint.
    #[account(
        mut,
        constraint = owner_token_account.mint == market.collateral_mint
            @ GreekBetError::InvalidMint,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Redeem a resolved position.
///
/// # Ordering: state first, CPI second
///
/// The share counts are zeroed on the in-memory account *before* the transfer
/// is built. Anchor writes account data back at `exit()`, but the ordering
/// still matters: the payout is computed from a snapshot taken before the
/// mutation, and no code path between the mutation and the CPI can observe a
/// non-zero position.
///
/// # Why a second `redeem` cannot pay out again
///
/// Two independent defences, either of which is sufficient:
///
/// * **Account-level.** `close = owner` on `position` makes Anchor zero the
///   account's data, write the closed-account discriminator, and drain its
///   lamports to the owner when this instruction exits successfully. A second
///   `redeem` fails deserialisation before the handler runs
///   (`AccountNotInitialized` / discriminator mismatch), and the PDA seeds
///   constraint means no substitute account can stand in for it.
/// * **State-level.** *Both* `yes_shares` and `no_shares` are zeroed, not just
///   the winning side. If the close were ever removed, a second call would see
///   `position.is_empty()` and fail with
///   [`GreekBetError::NothingToRedeem`] before computing any payout. Zeroing
///   only the winning side would leave `is_empty()` false for a mixed holder
///   and let a second call re-enter the payout path with a zero amount — still
///   not a double-pay, but it would leave a redeemed position looking live.
///
/// Re-entrancy is not a concern for the close: the only CPI made here is to the
/// SPL Token program, which cannot call back into this program.
pub fn redeem_handler(ctx: Context<Redeem>) -> Result<()> {
    // 1. The market must be resolved, and the winner must actually be recorded.
    //    `require_resolved` exists so this path never has to `unwrap` the
    //    `Option<Outcome>`: a `Resolved` status with `winning_outcome == None`
    //    is an invariant violation and surfaces as `MarketNotResolved`.
    let winning_outcome: Outcome = ctx.accounts.market.require_resolved()?;

    // 2. Snapshot the position before touching it.
    let winning_shares = ctx.accounts.position.shares(winning_outcome);
    let losing_shares = ctx.accounts.position.shares(winning_outcome.other());

    // An already-empty position is the *only* `NothingToRedeem` case. A holder
    // of purely losing shares is not empty: they redeem for zero, have their
    // position cleared, and get their rent back. Erroring on them would strand
    // the account forever.
    require!(
        !ctx.accounts.position.is_empty(),
        GreekBetError::NothingToRedeem
    );

    // 3. Payout. Losing shares are worth nothing and are simply discarded, so
    //    only the winning side is converted. `checked_mul` even though the
    //    scale is 1 today: the moment `SHARES_TO_COLLATERAL_SCALE` stops being
    //    1 this becomes a genuine overflow risk, and a future editor should not
    //    have to remember to add the check.
    let payout = winning_shares
        .checked_mul(SHARES_TO_COLLATERAL_SCALE)
        .ok_or(GreekBetError::MathOverflow)?;

    // 4. Solvency. LMSR bounds the market maker's loss at `b·ln 2`, which
    //    `create_market` deposits up front, so the vault provably covers every
    //    outstanding winning share. Checking anyway makes an accounting bug
    //    elsewhere fail loudly and attributably here rather than as an opaque
    //    `insufficient funds` from the token program.
    require!(
        ctx.accounts.vault.amount >= payout,
        GreekBetError::VaultInsolvent
    );

    // 5. STATE BEFORE CPI. Zero *both* sides — see the doc comment above for
    //    why the losing side must be cleared too.
    let position = &mut ctx.accounts.position;
    position.yes_shares = 0;
    position.no_shares = 0;

    // 6. Now, and only now, move the money. Skipped entirely for a pure loser:
    //    a zero-amount SPL transfer is legal but pointless, and skipping it
    //    keeps the losing path cheap and free of token-program failure modes.
    if payout > 0 {
        let market = &ctx.accounts.market;

        // The vault's authority is the *market* PDA (plan §2.1, T06), so the
        // market's own seeds sign the withdrawal — `MARKET_SEED` plus the
        // creator and question hash the market stored at creation, with
        // `market.bump`.
        //
        // Note `market.vault_bump` is deliberately NOT used here: it is the
        // bump of the vault PDA's own derivation, not of the signing
        // authority. Signing with it would derive the wrong key. The vault is
        // instead pinned by the `address = market.vault` constraint above.
        let market_bump = [market.bump];
        let market_seeds: &[&[u8]] = &[
            MARKET_SEED,
            market.creator.as_ref(),
            market.question_hash.as_ref(),
            &market_bump,
        ];
        let signer_seeds = &[market_seeds];

        // NOTE for T06/T07: Anchor 1.2.0's `CpiContext::new*` takes the program
        // **`Pubkey`**, not an `AccountInfo` — `.to_account_info()` here is a
        // type error, unlike in Anchor 0.2x.
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer_seeds,
            ),
            payout,
        )?;
    }

    emit!(Redeemed {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        winning_outcome,
        winning_shares,
        losing_shares,
        payout,
        position_closed: true,
    });

    Ok(())
}

/// Emitted on every successful redemption, including a zero-payout one.
///
/// `winning_shares` and `losing_shares` are the pre-clear snapshot, so an
/// indexer can reconstruct what the holder had without reading an account that
/// no longer exists.
#[event]
pub struct Redeemed {
    /// The market that was redeemed against.
    pub market: Pubkey,
    /// The position holder and rent recipient.
    pub owner: Pubkey,
    /// The side that won, per `resolve_market`.
    pub winning_outcome: Outcome,
    /// Winning-side shares held immediately before the position was cleared.
    pub winning_shares: u64,
    /// Losing-side shares held immediately before the position was cleared.
    /// These paid nothing.
    pub losing_shares: u64,
    /// Collateral base units transferred out of the vault. Equals
    /// `winning_shares` (1:1) and is `0` for a pure loser.
    pub payout: u64,
    /// Always `true` in this version — the `UserPosition` PDA is closed and its
    /// rent returned to `owner`. Emitted explicitly so an indexer does not have
    /// to infer it from program version.
    pub position_closed: bool,
}
