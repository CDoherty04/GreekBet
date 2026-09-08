//! Program error codes. Owned by T05.
//!
//! T06/T07/T08 map their validations onto these variants. If a handler needs a
//! condition that is not represented here, report it rather than inventing a
//! generic error — a precise code is what lets T09 assert that a negative test
//! failed for the *right* reason instead of merely failing.
//!
//! Anchor numbers custom errors from 6000, so `MarketNotOpen` is 6000,
//! `MarketNotClosed` is 6001, and so on in declaration order. **Do not reorder
//! these variants** once tests reference them: the discriminant is what appears
//! on-chain and in TS assertions.

use anchor_lang::prelude::*;

#[error_code]
pub enum GreekBetError {
    // ---- lifecycle -------------------------------------------------------
    /// Trading was attempted on a market that is not `Open`, or `close_market`
    /// was called on one that is already `Closed`/`Resolved`.
    #[msg("Market is not open")]
    MarketNotOpen,

    /// `resolve_market` was called before `close_market`. The only legal
    /// transition is `Open -> Closed -> Resolved`.
    #[msg("Market is not closed")]
    MarketNotClosed,

    /// `redeem` was called before the resolver wrote a winning outcome.
    ///
    /// Also returned by [`Market::require_resolved`](crate::state::Market::require_resolved)
    /// when `status == Resolved` but `winning_outcome` is `None` — an invariant
    /// violation that must surface as an error rather than an `unwrap`.
    #[msg("Market is not resolved")]
    MarketNotResolved,

    /// `resolve_market` was called a second time.
    #[msg("Market is already resolved")]
    MarketAlreadyResolved,

    /// `close_market` was cranked before `close_time`.
    #[msg("Close time has not been reached")]
    CloseTimeNotReached,

    /// `create_market` was given a `close_time` at or before the current
    /// `Clock` timestamp, which would produce a market that could never trade.
    #[msg("Close time is in the past")]
    CloseTimeInPast,

    // ---- authorization ---------------------------------------------------
    /// The signer is not the market's stored `resolver`.
    ///
    /// The resolver is a bare pubkey with no other logic attached (plan
    /// §2.2/§2.3) — this is the whole of the access control in this phase.
    #[msg("Signer is not the resolver authority")]
    Unauthorized,

    // ---- LMSR parameter bounds (mirror lmsr::LmsrError) ------------------
    /// `b` is outside `[lmsr::B_MIN, lmsr::B_MAX]` (D4: 10 .. 1,000,000 USDC).
    #[msg("Liquidity parameter b is out of range")]
    BOutOfRange,

    /// A share quantity would exceed `lmsr::MAX_Q`.
    ///
    /// The LMSR crate deliberately does **not** clamp `shares_for_cost`; it
    /// returns the mathematical answer and enforcing the cap is the program's
    /// job (T07). T01 found 55 vector cases that legitimately exceed it, so
    /// this is a reachable path, not a theoretical one.
    #[msg("Share quantity is out of range")]
    QOutOfRange,

    // ---- trading ---------------------------------------------------------
    /// A buy or sell would have been worse for the caller than the limit they
    /// supplied (`max_slippage` / `min_usdc_out`).
    ///
    /// Enforced on-chain, never delegated to the client (plan §2.3). The
    /// failure must be clean: no state written, no tokens moved.
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,

    /// A sell or redeem referenced more shares than the position holds.
    #[msg("Insufficient shares in position")]
    InsufficientShares,

    /// A trade priced out to zero collateral.
    ///
    /// Reachable at extreme skew: beyond `(q_min - q_max)/b < -138` the exact
    /// cost falls below 1e-60 and rounds to zero, so shares of the near-certain
    /// loser could be acquired for nothing. T01's oracle does not floor this and
    /// the vault stays solvent either way, but it is a free option. T07 decides
    /// whether to reject it; see `docs/tickets/T07-trading-instructions.md` 6a.
    #[msg("Trade moves zero collateral or zero shares")]
    ZeroCostTrade,

    // ---- token accounts --------------------------------------------------
    /// A token account's mint is not the market's `collateral_mint`.
    ///
    /// The mint is per-market runtime config (D3) — local tests use a throwaway
    /// 6-decimal mint, devnet uses Circle's USDC — so every token account must
    /// be checked against the stored field, never against a constant.
    #[msg("Token account mint does not match the market collateral mint")]
    InvalidMint,

    /// The supplied vault is not the market's stored `vault`.
    #[msg("Vault account does not match the market vault")]
    InvalidVault,

    /// The collateral mint does not have `lmsr::DECIMALS` decimals.
    ///
    /// Shares and collateral must share a unit for redemption to be a 1:1
    /// mapping (T08). A mint with different decimals would silently break that.
    #[msg("Collateral mint must have 6 decimals")]
    InvalidMintDecimals,

    /// The vault holds less than a withdrawal requires.
    ///
    /// LMSR guarantees solvency mathematically, so reaching this means an
    /// accounting bug elsewhere. It is checked explicitly so the failure is
    /// loud and attributable rather than an opaque token-program error.
    #[msg("Vault is insolvent for this withdrawal")]
    VaultInsolvent,

    // ---- misc ------------------------------------------------------------
    /// The question exceeds [`MAX_QUESTION_LEN`](crate::constants::MAX_QUESTION_LEN)
    /// bytes. Note the cap counts UTF-8 bytes, not characters.
    #[msg("Question exceeds the maximum length")]
    QuestionTooLong,

    /// `redeem` was called on a position that is already empty.
    ///
    /// A holder of only losing shares is **not** this case — they redeem
    /// successfully for zero and have their position cleared (T08).
    #[msg("Nothing to redeem")]
    NothingToRedeem,

    /// Checked arithmetic overflowed, or the LMSR core reported an overflow.
    #[msg("Arithmetic overflow")]
    MathOverflow,

    /// The LMSR core reported a division by zero.
    #[msg("Division by zero")]
    DivByZero,

    /// The LMSR core rejected an input that none of the more specific variants
    /// describe.
    #[msg("Invalid input")]
    InvalidInput,
}

/// Surface LMSR failures as program errors instead of generic panics.
///
/// The mapping is total and mirrors `lmsr::LmsrError`'s frozen `#[repr(u32)]`
/// discriminants (`BOutOfRange=0, QOutOfRange=1, InsufficientShares=2,
/// Overflow=3, DivByZero=4, InvalidInput=5`). Handlers should write
/// `lmsr::buy_cost(..)?` and let this conversion do the work.
impl From<lmsr::LmsrError> for GreekBetError {
    fn from(e: lmsr::LmsrError) -> Self {
        match e {
            lmsr::LmsrError::BOutOfRange => GreekBetError::BOutOfRange,
            lmsr::LmsrError::QOutOfRange => GreekBetError::QOutOfRange,
            lmsr::LmsrError::InsufficientShares => GreekBetError::InsufficientShares,
            lmsr::LmsrError::Overflow => GreekBetError::MathOverflow,
            lmsr::LmsrError::DivByZero => GreekBetError::DivByZero,
            lmsr::LmsrError::InvalidInput => GreekBetError::InvalidInput,
        }
    }
}

/// Lets handlers use `?` on an `lmsr` call inside an Anchor `Result<_>`.
///
/// A blanket `impl From<lmsr::LmsrError> for anchor_lang::error::Error` is not
/// possible — both types are foreign to this crate, so the orphan rule rejects
/// it. An extension trait is the idiomatic way around that, and it keeps the
/// conversion explicit at the call site:
///
/// ```ignore
/// let cost = lmsr::buy_cost(q_yes, q_no, b, outcome.into(), shares).or_program_err()?;
/// ```
pub trait LmsrResultExt<T> {
    /// Convert an [`lmsr::LmsrError`] into the matching [`GreekBetError`].
    fn or_program_err(self) -> Result<T>;
}

impl<T> LmsrResultExt<T> for core::result::Result<T, lmsr::LmsrError> {
    fn or_program_err(self) -> Result<T> {
        self.map_err(|e| Error::from(GreekBetError::from(e)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Anchor numbers custom errors from 6000 in declaration order. Pinning the
    /// first and last here so an accidental reorder — which would silently
    /// change what every TS negative test asserts against — breaks the build.
    #[test]
    fn error_codes_are_stable() {
        assert_eq!(GreekBetError::MarketNotOpen as u32, 0);
        assert_eq!(
            anchor_lang::error::ERROR_CODE_OFFSET + GreekBetError::MarketNotOpen as u32,
            6000
        );
        // 21 variants, so the last one is 20 -> Anchor code 6020.
        assert_eq!(GreekBetError::InvalidInput as u32, 20);
        assert_eq!(
            anchor_lang::error::ERROR_CODE_OFFSET + GreekBetError::InvalidInput as u32,
            6020
        );
    }

    /// Every LMSR failure must map to something specific — no catch-all.
    #[test]
    fn lmsr_errors_map_totally() {
        let cases = [
            (lmsr::LmsrError::BOutOfRange, GreekBetError::BOutOfRange),
            (lmsr::LmsrError::QOutOfRange, GreekBetError::QOutOfRange),
            (
                lmsr::LmsrError::InsufficientShares,
                GreekBetError::InsufficientShares,
            ),
            (lmsr::LmsrError::Overflow, GreekBetError::MathOverflow),
            (lmsr::LmsrError::DivByZero, GreekBetError::DivByZero),
            (lmsr::LmsrError::InvalidInput, GreekBetError::InvalidInput),
        ];
        for (from, want) in cases {
            assert_eq!(GreekBetError::from(from) as u32, want as u32);
        }
    }
}
