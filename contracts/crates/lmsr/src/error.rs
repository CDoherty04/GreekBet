//! Crate-wide error type.
//!
//! [`LmsrError`] is a plain `#[repr(u32)]` C-like enum with **stable, explicit
//! discriminants**. The crate deliberately does not depend on Anchor (or on
//! `std`), so the on-chain wrapper (T07) is expected to map these onto its own
//! `#[error_code]` enum. Because the discriminants are fixed here, that mapping
//! is a total `match` that can never silently reorder.
//!
//! Anchor reserves custom error codes from `6000` upward; [`LmsrError::code`]
//! returns the *raw* 0-based discriminant, so a wrapper typically emits
//! `6000 + code()` or, better, an explicit per-variant `match`.

use crate::fixed::FixedError;

/// Everything the LMSR core can refuse to do.
///
/// No public function in this crate panics; every failure surfaces here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u32)]
pub enum LmsrError {
    /// The liquidity parameter `b` is outside
    /// [`B_MIN`](crate::bounds::B_MIN)`..=`[`B_MAX`](crate::bounds::B_MAX).
    BOutOfRange = 0,
    /// A share quantity is outside `0..=`[`MAX_Q`](crate::bounds::MAX_Q).
    /// Also returned when a buy would push a side past `MAX_Q`.
    QOutOfRange = 1,
    /// A sell asked for more shares than the outcome's outstanding supply.
    InsufficientShares = 2,
    /// An intermediate value did not fit the Q64.64 representation, or an
    /// integer conversion at the crate boundary overflowed.
    Overflow = 3,
    /// A division by zero was attempted. Unreachable for in-range inputs; the
    /// log-sum-exp form guarantees the denominator is at least `1`.
    DivByZero = 4,
    /// An argument was outside a function's mathematical domain, e.g. `ln` of a
    /// non-positive value.
    InvalidInput = 5,
}

impl LmsrError {
    /// The stable 0-based discriminant. Frozen: never renumber these.
    #[inline]
    pub const fn code(self) -> u32 {
        self as u32
    }

    /// A short, allocation-free description. `no_std`-friendly.
    #[inline]
    pub const fn message(self) -> &'static str {
        match self {
            LmsrError::BOutOfRange => "liquidity parameter b out of range",
            LmsrError::QOutOfRange => "share quantity out of range",
            LmsrError::InsufficientShares => "insufficient shares to sell",
            LmsrError::Overflow => "arithmetic overflow",
            LmsrError::DivByZero => "division by zero",
            LmsrError::InvalidInput => "invalid input",
        }
    }
}

impl core::fmt::Display for LmsrError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.message())
    }
}

/// [`FixedError`] maps 1:1 onto the arithmetic variants of [`LmsrError`].
impl From<FixedError> for LmsrError {
    #[inline]
    fn from(e: FixedError) -> Self {
        match e {
            FixedError::Overflow => LmsrError::Overflow,
            FixedError::DivByZero => LmsrError::DivByZero,
            FixedError::Domain => LmsrError::InvalidInput,
        }
    }
}

/// Shorthand for every fallible operation in this crate.
pub type Result<T> = core::result::Result<T, LmsrError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminants_are_frozen() {
        assert_eq!(LmsrError::BOutOfRange.code(), 0);
        assert_eq!(LmsrError::QOutOfRange.code(), 1);
        assert_eq!(LmsrError::InsufficientShares.code(), 2);
        assert_eq!(LmsrError::Overflow.code(), 3);
        assert_eq!(LmsrError::DivByZero.code(), 4);
        assert_eq!(LmsrError::InvalidInput.code(), 5);
    }

    #[test]
    fn fixed_error_maps_one_to_one() {
        assert_eq!(LmsrError::from(FixedError::Overflow), LmsrError::Overflow);
        assert_eq!(LmsrError::from(FixedError::DivByZero), LmsrError::DivByZero);
        assert_eq!(LmsrError::from(FixedError::Domain), LmsrError::InvalidInput);
    }
}
