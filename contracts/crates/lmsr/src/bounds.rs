//! Domain bounds for the LMSR core, frozen by `docs/DESIGN_DECISIONS.md` D1/D4.
//!
//! Every constant here is a count of **6-decimal base units**. Nothing in this
//! crate ever works in USDC-denominated floating point:
//!
//! ```text
//! 1_000_000 base units == 1 USDC == 1 share
//! ```
//!
//! These are the same numbers the Python oracle (`reference/lmsr_ref.py`)
//! enforces, so a value rejected here is rejected there and vice versa.

use crate::error::{LmsrError, Result};

/// Decimal places carried by every external quantity (D1).
///
/// Fixed at 6 to match USDC. It is *not* a tunable: `UNIT` below and the golden
/// vectors in `reference/vectors/` both assume it.
pub const DECIMALS: u8 = 6;

/// Base units in one whole unit — one USDC of collateral, or one share (D1).
///
/// Prices are also expressed in these units, so `500_000` is a price of `0.5`
/// and `UNIT` is a price of `1.0`.
pub const UNIT: u64 = 1_000_000;

/// Smallest permitted liquidity parameter: **10 USDC** (D4).
///
/// Below this a single small trade sweeps most of the `[0, 1]` price range, and
/// the relative error of the `q / b` ratio grows sharply.
pub const B_MIN: u64 = 10_000_000;

/// Largest permitted liquidity parameter: **1,000,000 USDC** (D4).
///
/// The market maker's worst-case subsidy is `b · ln 2 ≈ 693,147 USDC`, which is
/// far inside `u64` and inside Q64.64's integer range.
pub const B_MAX: u64 = 1_000_000_000_000;

/// Largest permitted outstanding supply on either side: **10^9 shares** (D4).
///
/// Enforced on every buy so `q_yes`/`q_no` can never walk towards `u64`
/// overflow. Note the deliberate exception in
/// [`shares_for_cost`](crate::lmsr::shares_for_cost), which returns the
/// unclamped mathematical answer and leaves the cap to the caller.
pub const MAX_Q: u64 = 1_000_000_000_000_000;

/// Accept `b` only inside `[B_MIN, B_MAX]`.
///
/// # Errors
///
/// [`LmsrError::BOutOfRange`] otherwise.
#[inline]
pub const fn validate_b(b: u64) -> Result<()> {
    if b < B_MIN || b > B_MAX {
        Err(LmsrError::BOutOfRange)
    } else {
        Ok(())
    }
}

/// Accept a share quantity only inside `[0, MAX_Q]`.
///
/// # Errors
///
/// [`LmsrError::QOutOfRange`] otherwise.
#[inline]
pub const fn validate_q(q: u64) -> Result<()> {
    if q > MAX_Q {
        Err(LmsrError::QOutOfRange)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_design_decisions() {
        assert_eq!(DECIMALS, 6);
        assert_eq!(UNIT, 1_000_000);
        assert_eq!(B_MIN, 10_000_000);
        assert_eq!(B_MAX, 1_000_000_000_000);
        assert_eq!(MAX_Q, 1_000_000_000_000_000);
        // 10 USDC and 1,000,000 USDC respectively.
        assert_eq!(B_MIN / UNIT, 10);
        assert_eq!(B_MAX / UNIT, 1_000_000);
    }

    #[test]
    fn validate_b_rejects_just_outside() {
        assert_eq!(validate_b(B_MIN - 1), Err(LmsrError::BOutOfRange));
        assert_eq!(validate_b(B_MAX + 1), Err(LmsrError::BOutOfRange));
        assert_eq!(validate_b(0), Err(LmsrError::BOutOfRange));
        assert_eq!(validate_b(u64::MAX), Err(LmsrError::BOutOfRange));
        assert_eq!(validate_b(B_MIN), Ok(()));
        assert_eq!(validate_b(B_MAX), Ok(()));
        assert_eq!(validate_b(123_456_789), Ok(()));
    }

    #[test]
    fn validate_q_rejects_above_max() {
        assert_eq!(validate_q(0), Ok(()));
        assert_eq!(validate_q(MAX_Q), Ok(()));
        assert_eq!(validate_q(MAX_Q + 1), Err(LmsrError::QOutOfRange));
        assert_eq!(validate_q(u64::MAX), Err(LmsrError::QOutOfRange));
    }
}
