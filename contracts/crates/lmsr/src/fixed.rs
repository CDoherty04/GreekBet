//! # Q64.64 signed fixed-point primitives
//!
//! The arithmetic layer of the LMSR crate. **No LMSR semantics live here** —
//! see `lmsr.rs` (T03) for those.
//!
//! ## Format (frozen — `docs/DESIGN_DECISIONS.md` D1)
//!
//! A [`Fixed`] wraps an `i128` interpreted as a Q64.64 number: 64 integer bits,
//! 64 fractional bits, so one raw unit ("ulp") is `2^-64 ≈ 5.4210e-20`.
//!
//! | | value |
//! |---|---|
//! | resolution (1 ulp) | `2^-64 ≈ 5.421e-20` |
//! | representable range | `[-2^63, 2^63) ≈ [-9.223e18, 9.223e18)` |
//!
//! ## Units
//!
//! Everything crossing the crate boundary is a plain integer count of **6-decimal
//! base units** (`1_000_000` base units = 1 USDC = 1 share). A [`Fixed`] holds
//! that same count, not a USDC-denominated value: `from_base_units(1_000_000)`
//! is the fixed-point number `1000000.0`. The conversion is therefore exact for
//! every `q`, `b` and collateral amount in the legal domain (`≤ 1e15 < 2^63`).
//!
//! ## Safety contract
//!
//! * `#![no_std]`, zero dependencies, no floating point outside `#[cfg(test)]`.
//! * **No public function can panic on any input.** Every fallible operation
//!   returns [`Option`] (the `checked_*` family) or [`Result<_, FixedError>`].
//!   There is no `unwrap`, no `expect`, no indexing, and no unchecked
//!   arithmetic on any path reachable from a public API. `overflow-checks` is
//!   left on in release so that an escaped case aborts rather than wraps.
//!
//! ## Accuracy of [`Fixed::exp`], [`Fixed::ln`] and [`Fixed::expm1`]
//!
//! These are **measured, not aspirational**. Each function is checked against a
//! 128-point golden table whose entries are the correctly-rounded Q64.64 values
//! produced by `mpmath` at 500-bit precision (regenerate with
//! `python crates/lmsr/gen_golden.py`). The tests below recompute the maxima on
//! every run and assert the "asserted" column, so a regression fails the build.
//!
//! | function | domain | max abs error (measured) | asserted | max rel error (measured) | asserted |
//! |---|---|---|---|---|---|
//! | `exp(x)`   | `x ∈ [-45, 0]`      | **2 ulp** = `1.08e-19` | ≤ 3 ulp  | **2.17e-19** | ≤ 5.0e-19 |
//! | `expm1(x)` | `x ∈ [-45, 0]`      | **2 ulp** = `1.08e-19` | ≤ 3 ulp  | **1.01e-19** | ≤ 5.0e-19 |
//! | `ln(x)`    | `x ∈ [2^-64, 2^63)` | **15 ulp** = `8.1e-19` | ≤ 20 ulp | **2.17e-19** | ≤ 5.0e-19 |
//!
//! Also cross-checked against `f64` over a 4001-point sweep of `exp` on
//! `[-40, 0]` and 8001 points of `ln` on `[e^-40, e^40]`: max relative deviation
//! `1.99e-16` for `exp` and `0` for `ln` — i.e. at or below `f64`'s own
//! `1.1e-16` resolution, which is why the golden tables, not `f64`, define the
//! bound above.
//!
//! **Read the "max abs error" column, not the relative one.** The relative
//! figures are measured only where `|result| ≥ 1/2`, because a fixed-point
//! format cannot carry relative precision on small values (next section). What
//! propagates through the LMSR's `b · ln(·)` is the absolute error.
//!
//! `ln`'s 15 ulp is dominated by the range reduction, not the series: the
//! rounded [`Fixed::LN_2`] constant is off by `0.211` ulp and is multiplied by
//! `k ∈ [-64, 62]`, contributing up to 13.3 ulp on its own.
//!
//! T04 may hold the implementation to exactly these numbers.
//!
//! ### The relative-error cliff, and what T03 must do about it
//!
//! Q64.64 is a *fixed*-point format: a result whose magnitude is `v` carries at
//! best a relative accuracy of `2^-64 / v`. So `exp(-35) ≈ 6.3e-16` is only good
//! to ~1e-4 *relatively*, even though its absolute error is still 1 ulp. This is
//! inherent to D1, not an implementation defect.
//!
//! Consequence for the LMSR: `b · ln(z)` carries an absolute error of about
//! `b · abs_err(z) / z`. That is harmless while `z` is near 1 (the log-sum-exp
//! `S ∈ [1, 2]` case, error `≈ b · 2^-64`, i.e. `< 1e-7` base units even at
//! `b = B_MAX`), but it degrades sharply for `z ≪ 1`. Wherever T03 needs
//! `b · ln(u_i · w)` with a tiny `u_i`, it must factor the tiny term out
//! analytically — `b·ln(u_i) = q_i − m` exactly — rather than feeding a
//! denormal-ish `Fixed` into `ln`.
//!
//! ## Domain notes
//!
//! * `exp(x)` **underflowing to `0` for very negative `x` is the correct
//!   answer**, not an error. The log-sum-exp form in D4 reaches exponents of
//!   `−1e8` at `q = MAX_Q, b = B_MIN`, so this path is genuinely exercised.
//!   `exp` returns exactly `ZERO` for every `x ≤ -45` (the true value there is
//!   `< 2.9e-20`, i.e. below half an ulp).
//! * `exp` is also implemented for `x > 0` and returns
//!   [`FixedError::Overflow`] above `ln(2^63) ≈ 43.668`. T03 does not need that
//!   branch; only `x ≤ 0` is covered by the accuracy table above.
//! * `ln(0)` and `ln(x < 0)` return [`FixedError::Domain`]. They never panic.

use core::cmp::Ordering;

// ---------------------------------------------------------------------------
// Raw constants
// ---------------------------------------------------------------------------

/// Number of fractional bits in the representation.
pub const FRAC_BITS: u32 = 64;

const ONE_RAW: i128 = 1i128 << FRAC_BITS;
const FRAC_MASK: i128 = ONE_RAW - 1;

/// `round(ln(2) · 2^64)`.
const LN_2_RAW: i128 = 12_786_308_645_202_655_660;
/// `round(e · 2^64)`.
const E_RAW: i128 = 50_143_449_209_799_256_683;
/// `round(sqrt(2) · 2^64)`.
const SQRT_2_RAW: i128 = 26_087_635_650_665_564_425;

/// `exp(x)` is exactly zero in Q64.64 for every `x ≤ -45`: `exp(-45) ≈ 2.86e-20`
/// and half an ulp is `2.71e-20`.
const EXP_UNDERFLOW_RAW: i128 = -45 * ONE_RAW;
/// `exp(x)` cannot be represented for `x > ln(2^63) ≈ 43.668`; 45 is a cheap
/// conservative pre-filter, the exact boundary is caught by the checked shift.
const EXP_OVERFLOW_RAW: i128 = 45 * ONE_RAW;

/// Iteration caps. Both are unreachable in practice (the series terms hit zero
/// first); they exist so that no loop in this module can fail to terminate.
const EXP_MAX_TERMS: u32 = 48;
const LN_MAX_TERMS: u32 = 48;

/// `|x| < 1/2` uses the direct `expm1` series instead of `exp(x) - 1`.
const EXPM1_SERIES_LIMIT: i128 = ONE_RAW / 2;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Failure modes of the fixed-point layer.
///
/// Deliberately *not* the crate-wide LMSR error type (T03 owns `error.rs`);
/// mapping is a one-line `From` impl there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FixedError {
    /// The exact result does not fit in Q64.64.
    Overflow,
    /// Division (or a ratio) with a zero denominator.
    DivByZero,
    /// Argument outside the function's mathematical domain, e.g. `ln(x ≤ 0)`,
    /// or a negative value converted to an unsigned integer.
    Domain,
}

// ---------------------------------------------------------------------------
// Wide (256-bit) helpers
//
// `i128 × i128 >> 64` and `(i128 << 64) / i128` both need a 256-bit
// intermediate. Rather than take a bignum dependency, both are hand-rolled from
// `u128` halves on the magnitudes, with the sign reapplied afterwards.
// ---------------------------------------------------------------------------

const LO64: u128 = u64::MAX as u128;

/// Full 128x128 -> 256 bit unsigned product, returned as `(high, low)`.
///
/// Schoolbook on four 64-bit limbs; every partial product is `< 2^128` so no
/// intermediate can overflow.
#[inline]
const fn wide_mul(a: u128, b: u128) -> (u128, u128) {
    let a0 = a & LO64;
    let a1 = a >> 64;
    let b0 = b & LO64;
    let b1 = b >> 64;

    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;

    // Sum the middle column with its carry into the high word.
    let mid = (p00 >> 64) + (p01 & LO64) + (p10 & LO64);
    let lo = (p00 & LO64) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

/// `floor((a * b) / 2^64)` for unsigned magnitudes, optionally rounding the
/// discarded 64 bits to nearest (ties up). `None` when the result exceeds
/// `u128`.
#[inline]
fn wide_mul_shr64(a: u128, b: u128, round: bool) -> Option<u128> {
    let (mut hi, mut lo) = wide_mul(a, b);
    if round {
        let (l, carry) = lo.overflowing_add(1u128 << 63);
        lo = l;
        if carry {
            hi = hi.checked_add(1)?;
        }
    }
    if hi >> 64 != 0 {
        return None;
    }
    Some((lo >> 64) | (hi << 64))
}

/// `floor((a * 2^64) / b)` for unsigned magnitudes, `None` on `b == 0` or when
/// the quotient exceeds `u128`.
///
/// `a * 2^64` is a 192-bit value, so this is a 256/128 division. It is done in
/// two exact halves:
///
/// ```text
///   a = qh·b + r        (native u128 division, r < b)
///   floor(a·2^64 / b) = qh·2^64 + floor(r·2^64 / b)
/// ```
///
/// The second term is a restoring binary division of exactly 64 steps. The
/// doubling `r → 2r` can leave `u128`, so the overflowed bit is carried
/// explicitly; `wrapping_sub` then produces the correct remainder because the
/// true value `2r − b` is always `< b ≤ u128::MAX`.
fn wide_div_shl64(a: u128, b: u128) -> Option<u128> {
    if b == 0 {
        return None;
    }
    let q_hi = a / b;
    if q_hi > LO64 {
        // q_hi · 2^64 alone would exceed u128.
        return None;
    }
    let mut rem = a % b;
    let mut q_lo: u128 = 0;
    let mut i = 0u32;
    while i < 64 {
        let carry = rem >> 127;
        rem = rem.wrapping_shl(1);
        q_lo <<= 1;
        if carry == 1 || rem >= b {
            rem = rem.wrapping_sub(b);
            q_lo |= 1;
        }
        i += 1;
    }
    (q_hi << 64).checked_add(q_lo)
}

/// Reattach a sign to an unsigned magnitude. `None` if it does not fit `i128`.
#[inline]
const fn from_magnitude(mag: u128, negative: bool) -> Option<i128> {
    if negative {
        if mag > (1u128 << 127) {
            None
        } else if mag == (1u128 << 127) {
            Some(i128::MIN)
        } else {
            Some(-(mag as i128))
        }
    } else if mag > i128::MAX as u128 {
        None
    } else {
        Some(mag as i128)
    }
}

/// `v >> n` on an unsigned magnitude, rounded to nearest (ties up).
#[inline]
fn shr_round(v: u128, n: u32) -> u128 {
    if n == 0 {
        return v;
    }
    if n >= 128 {
        return 0;
    }
    (v >> n) + ((v >> (n - 1)) & 1)
}

/// `v << n` for `i128`, `None` if any significant bit would be shifted out.
#[inline]
fn shl_checked(v: i128, n: u32) -> Option<i128> {
    if n == 0 {
        return Some(v);
    }
    if n >= 127 {
        return if v == 0 { Some(0) } else { None };
    }
    let r = v << n;
    if (r >> n) == v {
        Some(r)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// The type
// ---------------------------------------------------------------------------

/// A Q64.64 signed fixed-point number (64 integer bits, 64 fractional bits).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Fixed(i128);

impl Fixed {
    // -- constants ---------------------------------------------------------

    /// `0`.
    pub const ZERO: Fixed = Fixed(0);
    /// `1`.
    pub const ONE: Fixed = Fixed(ONE_RAW);
    /// `-1`.
    pub const NEG_ONE: Fixed = Fixed(-ONE_RAW);
    /// `ln 2 ≈ 0.6931471805599453094`, correctly rounded.
    pub const LN_2: Fixed = Fixed(LN_2_RAW);
    /// `e ≈ 2.7182818284590452354`, correctly rounded.
    pub const E: Fixed = Fixed(E_RAW);
    /// `√2 ≈ 1.4142135623730950488`, correctly rounded.
    pub const SQRT_2: Fixed = Fixed(SQRT_2_RAW);
    /// Smallest representable value, `-2^63`.
    pub const MIN: Fixed = Fixed(i128::MIN);
    /// Largest representable value, `2^63 - 2^-64`.
    pub const MAX: Fixed = Fixed(i128::MAX);
    /// One unit in the last place, `2^-64`.
    pub const EPSILON: Fixed = Fixed(1);

    // -- raw access --------------------------------------------------------

    /// Wrap a raw Q64.64 bit pattern. Total.
    #[inline]
    pub const fn from_raw(raw: i128) -> Self {
        Fixed(raw)
    }

    /// The raw Q64.64 bit pattern. Total.
    #[inline]
    pub const fn to_raw(self) -> i128 {
        self.0
    }

    #[inline]
    pub const fn is_zero(self) -> bool {
        self.0 == 0
    }

    #[inline]
    pub const fn is_negative(self) -> bool {
        self.0 < 0
    }

    #[inline]
    pub const fn is_positive(self) -> bool {
        self.0 > 0
    }

    // -- conversions -------------------------------------------------------

    /// Exact conversion from a whole number. Total: every `i64` fits the 64
    /// integer bits.
    #[inline]
    pub const fn from_int(n: i64) -> Self {
        Fixed((n as i128) << FRAC_BITS)
    }

    /// Exact conversion from a count of 6-decimal base units.
    ///
    /// The value *is* the count (`from_base_units(1_000_000) == 1000000.0`),
    /// matching `reference/lmsr_ref.py`, which works entirely in base units.
    /// Fails only for `n ≥ 2^63`, far above `MAX_Q = 1e15`.
    #[inline]
    pub const fn from_base_units(n: u64) -> Result<Self, FixedError> {
        if n > i64::MAX as u64 {
            return Err(FixedError::Overflow);
        }
        Ok(Fixed((n as i128) << FRAC_BITS))
    }

    /// `num / den` as a Q64.64 number, truncated toward zero.
    ///
    /// This is the `q / b` conversion at the crate boundary. Both arguments are
    /// raw integers (base units), not `Fixed` values.
    pub fn from_ratio(num: i128, den: i128) -> Result<Self, FixedError> {
        if den == 0 {
            return Err(FixedError::DivByZero);
        }
        let negative = (num < 0) != (den < 0);
        let mag = wide_div_shl64(num.unsigned_abs(), den.unsigned_abs())
            .ok_or(FixedError::Overflow)?;
        from_magnitude(mag, negative)
            .map(Fixed)
            .ok_or(FixedError::Overflow)
    }

    /// Largest integer `≤ self`. Total (arithmetic shift is a floor).
    #[inline]
    pub const fn to_int_floor(self) -> i64 {
        (self.0 >> FRAC_BITS) as i64
    }

    /// Smallest integer `≥ self`.
    #[inline]
    pub const fn to_int_ceil(self) -> Result<i64, FixedError> {
        let floor = self.0 >> FRAC_BITS;
        let c = if self.0 & FRAC_MASK != 0 {
            floor + 1
        } else {
            floor
        };
        if c > i64::MAX as i128 {
            Err(FixedError::Overflow)
        } else {
            Ok(c as i64)
        }
    }

    /// `floor(self)` as a count of base units. Rejects negatives.
    #[inline]
    pub const fn to_base_units_floor(self) -> Result<u64, FixedError> {
        if self.0 < 0 {
            return Err(FixedError::Domain);
        }
        let f = self.0 >> FRAC_BITS;
        if f > u64::MAX as i128 {
            Err(FixedError::Overflow)
        } else {
            Ok(f as u64)
        }
    }

    /// `ceil(self)` as a count of base units. Rejects negatives.
    #[inline]
    pub const fn to_base_units_ceil(self) -> Result<u64, FixedError> {
        if self.0 < 0 {
            return Err(FixedError::Domain);
        }
        let f = self.0 >> FRAC_BITS;
        let c = if self.0 & FRAC_MASK != 0 { f + 1 } else { f };
        if c > u64::MAX as i128 {
            Err(FixedError::Overflow)
        } else {
            Ok(c as u64)
        }
    }

    /// Test-only escape hatch for assertions. Gated so it can never reach the
    /// on-chain path — Solana's SBF target has no floating point.
    #[cfg(test)]
    pub fn to_f64(self) -> f64 {
        self.0 as f64 / 18_446_744_073_709_551_616.0
    }

    // -- checked arithmetic ------------------------------------------------

    #[inline]
    pub const fn checked_add(self, rhs: Self) -> Option<Self> {
        match self.0.checked_add(rhs.0) {
            Some(v) => Some(Fixed(v)),
            None => None,
        }
    }

    #[inline]
    pub const fn checked_sub(self, rhs: Self) -> Option<Self> {
        match self.0.checked_sub(rhs.0) {
            Some(v) => Some(Fixed(v)),
            None => None,
        }
    }

    #[inline]
    pub const fn checked_neg(self) -> Option<Self> {
        match self.0.checked_neg() {
            Some(v) => Some(Fixed(v)),
            None => None,
        }
    }

    #[inline]
    pub const fn checked_abs(self) -> Option<Self> {
        match self.0.checked_abs() {
            Some(v) => Some(Fixed(v)),
            None => None,
        }
    }

    /// `self * rhs`, **truncated toward zero**.
    ///
    /// The `i128 × i128 >> 64` intermediate is evaluated as a full 256-bit
    /// product on the magnitudes ([`wide_mul`]) before the shift, so nothing is
    /// lost or wrapped on the way.
    #[inline]
    pub fn checked_mul(self, rhs: Self) -> Option<Self> {
        self.mul_inner(rhs, false)
    }

    /// `self * rhs`, rounded to nearest (ties away from zero).
    ///
    /// Preferred inside iterative evaluation: it halves the per-step bias
    /// compared with truncation. All series in this module use it.
    #[inline]
    pub fn checked_mul_nearest(self, rhs: Self) -> Option<Self> {
        self.mul_inner(rhs, true)
    }

    #[inline]
    fn mul_inner(self, rhs: Self, round: bool) -> Option<Self> {
        let negative = (self.0 < 0) != (rhs.0 < 0);
        let mag = wide_mul_shr64(self.0.unsigned_abs(), rhs.0.unsigned_abs(), round)?;
        from_magnitude(mag, negative).map(Fixed)
    }

    /// `self / rhs`, **truncated toward zero**. `None` on a zero divisor or
    /// overflow.
    #[inline]
    pub fn checked_div(self, rhs: Self) -> Option<Self> {
        if rhs.0 == 0 {
            return None;
        }
        let negative = (self.0 < 0) != (rhs.0 < 0);
        let mag = wide_div_shl64(self.0.unsigned_abs(), rhs.0.unsigned_abs())?;
        from_magnitude(mag, negative).map(Fixed)
    }

    /// `self / n` for a small positive integer `n`, rounded to nearest
    /// (ties away from zero). Used by the series below.
    #[inline]
    fn div_int_nearest(self, n: u32) -> Option<Self> {
        if n == 0 {
            return None;
        }
        let d = n as u128;
        let mag = self.0.unsigned_abs().checked_add(d / 2)? / d;
        from_magnitude(mag, self.0 < 0).map(Fixed)
    }

    // -- transcendental ----------------------------------------------------

    /// `e^self`.
    ///
    /// **The `self ≤ 0` domain is the one that matters** — the log-sum-exp form
    /// in `docs/DESIGN_DECISIONS.md` D4 guarantees non-positive arguments, so
    /// the result always lands in `(0, 1]` and can never overflow.
    ///
    /// Algorithm: range-reduce `x = -(n·ln2 + r)` with integer `n ≥ 0` and
    /// `r ∈ [0, ln2)`, evaluate `e^-r` by its alternating Taylor series to the
    /// point where the term underflows (≤ 21 terms for `r < ln 2`), then shift
    /// right by `n` with round-to-nearest. Positive arguments reuse the same
    /// series via `e^x = 2^(n+1) · e^-(ln2 - r)` and a checked left shift.
    ///
    /// # Underflow is a result, not an error
    ///
    /// Returns exactly [`Fixed::ZERO`] for `x ≤ -45`, where the true value is
    /// below half an ulp. The LMSR reaches exponents near `-1e8`, so this is a
    /// hot path, not a curiosity.
    ///
    /// # Errors
    ///
    /// [`FixedError::Overflow`] for `x` above `ln(2^63) ≈ 43.668`.
    pub fn exp(self) -> Result<Fixed, FixedError> {
        let x = self.0;
        if x == 0 {
            return Ok(Fixed::ONE);
        }
        if x <= EXP_UNDERFLOW_RAW {
            return Ok(Fixed::ZERO);
        }
        if x >= EXP_OVERFLOW_RAW {
            return Err(FixedError::Overflow);
        }

        if x < 0 {
            // x > -45·ONE here, so negation cannot overflow.
            let a = x.checked_neg().ok_or(FixedError::Overflow)?;
            let n = a / LN_2_RAW; // 0 ..= 64
            let r = a - n * LN_2_RAW; // exact; n·LN_2 ≤ 65·1.28e19 ≪ i128::MAX
            let e = exp_neg_series(Fixed(r))?;
            if n >= 128 {
                return Ok(Fixed::ZERO);
            }
            let shift = n as u32;
            let mag = shr_round(e.0.unsigned_abs(), shift);
            Ok(Fixed(from_magnitude(mag, false).ok_or(FixedError::Overflow)?))
        } else {
            // e^x = 2^(n+1) · e^-(ln2 - r)
            let n = x / LN_2_RAW;
            let r = x - n * LN_2_RAW;
            let r2 = LN_2_RAW - r; // (0, ln2]
            let e = exp_neg_series(Fixed(r2))?;
            let shift = u32::try_from(n + 1).map_err(|_| FixedError::Overflow)?;
            shl_checked(e.0, shift)
                .map(Fixed)
                .ok_or(FixedError::Overflow)
        }
    }

    /// `e^self - 1`, evaluated without the cancellation of `exp(x) - 1`.
    ///
    /// T03 needs `1 - e^(-X/b)` as `-expm1(-X/b)` in the closed form for
    /// `shares_for_cost`, where `X/b` can be as small as `1e-12`.
    ///
    /// For `|x| < 1/2` the series `Σ_{k≥1} x^k/k!` is summed directly (the
    /// leading term is the exact input, so no cancellation occurs); outside
    /// that band `exp(x) - 1` is already well conditioned and is used instead.
    ///
    /// Returns exactly `-1` for `x ≤ -45`. Same accuracy table as [`exp`].
    ///
    /// [`exp`]: Fixed::exp
    pub fn expm1(self) -> Result<Fixed, FixedError> {
        let x = self.0;
        if x == 0 {
            return Ok(Fixed::ZERO);
        }
        if x <= EXP_UNDERFLOW_RAW {
            return Ok(Fixed::NEG_ONE);
        }
        if x > -EXPM1_SERIES_LIMIT && x < EXPM1_SERIES_LIMIT {
            return expm1_series(self);
        }
        self.exp()?
            .checked_sub(Fixed::ONE)
            .ok_or(FixedError::Overflow)
    }

    /// Natural logarithm, for `self > 0`.
    ///
    /// Algorithm: split `x = 2^k · m` by the position of the leading bit, then
    /// nudge into the symmetric band `m ∈ [1/√2, √2)` so that
    /// `z = (m-1)/(m+1)` satisfies `|z| ≤ 0.1716`. Sum the odd `atanh` series
    /// `ln m = 2·(z + z³/3 + z⁵/5 + …)` (≤ 13 terms at that `|z|`), then add
    /// `k · ln2`.
    ///
    /// # Errors
    ///
    /// [`FixedError::Domain`] for `self ≤ 0` — including `ln(0)`. Never panics.
    pub fn ln(self) -> Result<Fixed, FixedError> {
        if self.0 <= 0 {
            return Err(FixedError::Domain);
        }
        let u = self.0 as u128;
        // u > 0, so `leading_zeros() < 128` and the subtraction is in range.
        let msb = 127 - u.leading_zeros(); // 0 ..= 126
        let mut k = msb as i32 - FRAC_BITS as i32; // -64 ..= 62
        let mut m = mantissa(u, k);
        if m >= SQRT_2_RAW as u128 {
            k += 1;
            m = mantissa(u, k);
        }
        // m ∈ [1/√2, √2) · 2^64, and always fits i128.
        let m = i128::try_from(m).map_err(|_| FixedError::Overflow)?;

        let num = Fixed(m - ONE_RAW);
        let den = Fixed(m.checked_add(ONE_RAW).ok_or(FixedError::Overflow)?);
        let z = num.checked_div(den).ok_or(FixedError::Overflow)?;
        let ln_m = atanh_series_x2(z)?;

        let k_term = (k as i128)
            .checked_mul(LN_2_RAW)
            .ok_or(FixedError::Overflow)?;
        Fixed(k_term)
            .checked_add(ln_m)
            .ok_or(FixedError::Overflow)
    }
}

// ---------------------------------------------------------------------------
// Series kernels (private)
// ---------------------------------------------------------------------------

/// Normalise `u` so its leading bit sits at position 64, i.e. return the
/// mantissa of `u = 2^k · m` with `m` in Q64.64.
///
/// Right shifts round to nearest; left shifts are exact. `k` is always in
/// `[-64, 63]` for a non-zero `i128`, so neither shift amount can reach 128.
fn mantissa(u: u128, k: i32) -> u128 {
    if k >= 0 {
        shr_round(u, k as u32)
    } else {
        let s = (-k) as u32;
        if s >= 128 {
            0
        } else {
            u << s
        }
    }
}

/// `e^-r` for `r ∈ [0, ln2]`, by the alternating Taylor series
/// `Σ (-r)^k / k!`.
///
/// Terms are built incrementally (`t_k = t_{k-1} · r / k`) with round-to-nearest
/// at every step and the loop stops as soon as a term underflows to zero — at
/// most 21 iterations for `r < ln 2`, capped at [`EXP_MAX_TERMS`] regardless.
/// The result lies in `[1/2, 1]`, so no intermediate can overflow.
fn exp_neg_series(r: Fixed) -> Result<Fixed, FixedError> {
    let mut sum = Fixed::ONE;
    let mut term = Fixed::ONE;
    let mut k: u32 = 1;
    while k <= EXP_MAX_TERMS {
        term = term
            .checked_mul_nearest(r)
            .ok_or(FixedError::Overflow)?
            .div_int_nearest(k)
            .ok_or(FixedError::Overflow)?;
        if term.is_zero() {
            break;
        }
        sum = if k % 2 == 1 {
            sum.checked_sub(term)
        } else {
            sum.checked_add(term)
        }
        .ok_or(FixedError::Overflow)?;
        k += 1;
    }
    Ok(sum)
}

/// `e^x - 1` for `|x| < 1/2` by direct summation of `Σ_{k≥1} x^k/k!`.
///
/// The `k = 1` term is `x` itself — exact — so the result keeps full absolute
/// accuracy even when `|x|` is far below 1, which `exp(x) - 1` would not.
fn expm1_series(x: Fixed) -> Result<Fixed, FixedError> {
    let mut sum = Fixed::ZERO;
    let mut term = Fixed::ONE;
    let mut k: u32 = 1;
    while k <= EXP_MAX_TERMS {
        term = term
            .checked_mul_nearest(x)
            .ok_or(FixedError::Overflow)?
            .div_int_nearest(k)
            .ok_or(FixedError::Overflow)?;
        if term.is_zero() {
            break;
        }
        sum = sum.checked_add(term).ok_or(FixedError::Overflow)?;
        k += 1;
    }
    Ok(sum)
}

/// `2·atanh(z) = ln((1+z)/(1-z))` for `|z| ≤ 0.1716`.
///
/// Sums `z + z³/3 + z⁵/5 + …` until a term underflows (≤ 13 iterations at that
/// `|z|`), then doubles. Capped at [`LN_MAX_TERMS`].
fn atanh_series_x2(z: Fixed) -> Result<Fixed, FixedError> {
    if z.is_zero() {
        return Ok(Fixed::ZERO);
    }
    let z2 = z.checked_mul_nearest(z).ok_or(FixedError::Overflow)?;
    let mut power = z;
    let mut sum = z;
    let mut d: u32 = 3;
    let mut i: u32 = 0;
    while i < LN_MAX_TERMS {
        power = power.checked_mul_nearest(z2).ok_or(FixedError::Overflow)?;
        if power.is_zero() {
            break;
        }
        let t = power.div_int_nearest(d).ok_or(FixedError::Overflow)?;
        if t.is_zero() {
            break;
        }
        sum = sum.checked_add(t).ok_or(FixedError::Overflow)?;
        d += 2;
        i += 1;
    }
    sum.checked_add(sum).ok_or(FixedError::Overflow)
}

// ---------------------------------------------------------------------------
// Trait impls
// ---------------------------------------------------------------------------

impl core::fmt::Display for FixedError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let s = match self {
            FixedError::Overflow => "fixed-point overflow",
            FixedError::DivByZero => "fixed-point division by zero",
            FixedError::Domain => "fixed-point domain error",
        };
        f.write_str(s)
    }
}

impl PartialEq<i128> for Fixed {
    fn eq(&self, other: &i128) -> bool {
        self.0 == *other
    }
}

impl PartialOrd<i128> for Fixed {
    fn partial_cmp(&self, other: &i128) -> Option<Ordering> {
        Some(self.0.cmp(other))
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::println;

    const ONE: i128 = ONE_RAW;

    // -- golden tables ----------------------------------------------------
    // Generated by `gen_golden.py` with mpmath at 500 bits (~150 decimal
    // digits), i.e. ~85 bits below the last Q64.64 bit of any entry here.
    // Each entry is
    // (raw argument, correctly-rounded raw result). See the module doc for the
    // bounds these establish.
    // __GOLDEN_BEGIN__
    const EXP_GOLDEN: &[(i128, i128)] = &[
        (-830103483316929822719, 1),
        (-828258808909558867558, 1),
        (-826688158136308215369, 1),
        (-820880111280075046912, 1),
        (-820847490374752598565, 1),
        (-819522305017654981363, 1),
        (-818297567109755709686, 1),
        (-815346088057962181427, 1),
        (-812359766852862019908, 1),
        (-811656739243220271104, 1),
        (-810712764267741821533, 2),
        (-802433367206365495296, 2),
        (-793209995169510719488, 4),
        (-776076975713574109782, 10),
        (-774763251095801167872, 11),
        (-762845074156523225322, 20),
        (-737869762948382064640, 78),
        (-732846322142459059176, 103),
        (-726814176960556485195, 143),
        (-710387542017661495571, 348),
        (-694502927607282460636, 822),
        (-687877798823594147713, 1178),
        (-682168177570517337088, 1605),
        (-657753723605044469335, 6030),
        (-654652751777931314474, 7134),
        (-647356841059401712368, 10595),
        (-645636042579834306560, 11631),
        (-627269593256082351688, 31479),
        (-625410900232809135465, 34816),
        (-623915589488606395991, 37756),
        (-621764442883433463532, 42425),
        (-600411323600097621010, 135004),
        (-589974677766300000253, 237715),
        (-589925020203952240770, 238356),
        (-581690263629502257100, 372476),
        (-572861638898287387686, 601107),
        (-570379094120346166203, 687699),
        (-559207779569694218860, 1260104),
        (-553402322211286548480, 1726177),
        (-532006462391500111225, 5505683),
        (-531850897106132816076, 5552310),
        (-529220667583368129744, 6403208),
        (-521075195519696910726, 9957898),
        (-516641501987264864954, 12663414),
        (-512599648669847598613, 15765537),
        (-509956638026408985873, 18194225),
        (-507216570227575559409, 21107821),
        (-484822093472524862442, 71068958),
        (-463139300724879472509, 230229629),
        (-461168601842738790400, 256187346),
        (-437872188914679256755, 905792339),
        (-434753085194266999775, 1072660216),
        (-433363961150296184041, 1156555639),
        (-428679086247742076512, 1490950578),
        (-423976776481024948725, 1923846585),
        (-419931800209847008052, 2395531710),
        (-415562735191804787160, 3035732371),
        (-412253419836862810666, 3632245488),
        (-411108236662151814014, 3864883553),
        (-397043578564706185471, 8284432873),
        (-372992021579703690419, 30514919046),
        (-369272503029615223284, 37332013066),
        (-368934881474191032320, 38021573370),
        (-347737326639691513441, 119974049957),
        (-333841048701609272702, 254829375505),
        (-330738214873150064024, 301508788326),
        (-326266825991871587063, 384211676415),
        (-309046167249301154547, 977235260950),
        (-276701161105643274240, 5642901817851),
        (-261945432604091040063, 12557374277016),
        (-259458361492492832014, 14369853136944),
        (-255671570483337519122, 17644336114776),
        (-247385084271023169925, 27650011656744),
        (-243956661835185453805, 33297466140253),
        (-232188016876216258746, 63020547486365),
        (-228505467544476053957, 76945103272978),
        (-220764381022876242686, 117065939824712),
        (-216048210397640492510, 151169464074725),
        (-209912617771344446640, 210821673936495),
        (-201808087354194954565, 327130804011029),
        (-198053392957737061506, 400976368545776),
        (-193770831067743360655, 505759186254154),
        (-190387621437285603311, 607568424063405),
        (-184467440737095516160, 837480885292947),
        (-180456224231523199567, 1040906162009975),
        (-178472885270576737903, 1159059225906047),
        (-165904574802782043577, 2290884848371154),
        (-142469776469269211258, 8160791018753598),
        (-138639749270419653026, 10043918162210562),
        (-129127208515966861312, 16821253244015389),
        (-121848761021334995572, 24958353860532378),
        (-116912230198674949302, 32616505448602737),
        (-109433239916654704302, 48923376923191203),
        (-105487894463322775351, 60590186651788008),
        (-104506585852440923533, 63900666386500740),
        (-104169623688066903029, 65078650456215163),
        (-103337488531075234981, 68081579367523105),
        (-102878519566975462600, 69796749512520918),
        (-102286167104678907760, 72074400907589603),
        (-92233720368547758080, 124293183874348898),
        (-55340232221128654848, 918409308362266469),
        (-54944065078942456417, 938346632267720217),
        (-39110390016326787919, 2213797553423484426),
        (-36893488147419103232, 2496495334008788800),
        (-27670116110564327424, 4116024959383911113),
        (-25526262666988939430, 4623289246989356584),
        (-20557032932877507425, 6052605821803181281),
        (-18446744073709551616, 6786177901268885275),
        (-12786308645202655661, 9223372036854775807),
        (-12786308645202655660, 9223372036854775808),
        (-12786308645202655659, 9223372036854775808),
        (-11303709648169407942, 9995275726940391519),
        (-9223372036854775808, 11188515852577165300),
        (-4611686018427387904, 14366338729722795843),
        (-1844674407370955162, 16691304278825489409),
        (-1152921504606846976, 17329112349219823219),
        (-184467440737095516, 18263195903389592621),
        (-72057594037927936, 18374827034086858297),
        (-18446744073709552, 18428306549934190034),
        (-281474976710656, 18446462600880313685),
        (-1099511627776, 18446742974197956608),
        (-4294967296, 18446744069414584320),
        (-16777216, 18446744073692774400),
        (-65536, 18446744073709486080),
        (-256, 18446744073709551360),
        (-2, 18446744073709551614),
        (-1, 18446744073709551615),
        (0, 18446744073709551616),
    ];

    const LN_GOLDEN: &[(i128, i128)] = &[
        (1, -818323753292969962226),
        (2, -805537444647767306567),
        (3, -798057933567677022588),
        (5, -788634864019772748867),
        (8, -779964827357361995247),
        (49, -746532340272855220325),
        (64, -741605901421754028268),
        (152, -725649515068024057775),
        (512, -703246975486146061288),
        (2013, -677992335063101018648),
        (2874, -671423843502474867037),
        (4096, -664888049550538094309),
        (8316, -651824609903758970616),
        (17530, -638068276484359796108),
        (32768, -626529123614930127330),
        (69492, -612661613888561979168),
        (121047, -602424274839045045302),
        (187955, -594307270765201618207),
        (262144, -588170197679322160350),
        (2097152, -549811271743714193371),
        (6386774, -529268072623732509170),
        (16777216, -511452345808106226392),
        (134217728, -473093419872498259412),
        (147721990, -471324953684092871982),
        (308138038, -457762616045787645266),
        (1073741824, -434734493936890292433),
        (8589934592, -396375568001282325453),
        (23034537048, -378179633628109876642),
        (68719476736, -358016642065674358474),
        (140733623493, -344793347305835593769),
        (549755813888, -319657716130066391495),
        (740120835118, -314172774922198452421),
        (971072500588, -309162866720065065126),
        (3640909535426, -284783877193509837957),
        (4398046511104, -281298790194458424515),
        (4705539156740, -280052161237400115461),
        (8587951429000, -268954233547889152278),
        (35184372088832, -242939864258850457536),
        (121584006075581, -220065838471095447258),
        (281474976710656, -204580938323242490557),
        (451342237017144, -195870711519502193937),
        (757290120311610, -186324142602577441135),
        (2251799813685248, -166222012387634523577),
        (6813674247369590, -145797746025253874640),
        (7886150821674813, -143101262795392548142),
        (18014398509481984, -127863086452026556598),
        (62482676025272630, -104920539186202633075),
        (144115188075855872, -89504160516418589619),
        (1152921504606846976, -51145234580810622639),
        (8000849660646567383, -15409305746134995337),
        (9223372036854775808, -12786308645202655660),
        (18446744073709551615, -1),
        (18446744073709551616, 0),
        (18446744073709551617, 1),
        (26087635650665564424, 6393154322601327829),
        (26087635650665564425, 6393154322601327830),
        (26087635650665564426, 6393154322601327831),
        (27670116110564327424, 7479511080090283979),
        (36893488147419103232, 12786308645202655660),
        (46116860184273879040, 16902580627994557700),
        (50143449209799256683, 18446744073709551616),
        (55340232221128654848, 20265819725292939639),
        (73786976294838206464, 25572617290405311320),
        (95856366760713847830, 30399551880181321010),
        (142335099347391307900, 37692162992969753709),
        (184467440737095516160, 42475197918399869020),
        (188800387556513776089, 42903482090790287473),
        (590295810358705651712, 63931543226013278299),
        (1844674407370955161600, 84950395836799738039),
        (4722366482869645213696, 102290469161621245278),
        (14015762144128167407926, 122358175054601083627),
        (18446744073709551616000, 127425593755199607059),
        (37778931862957161709568, 140649395097229212258),
        (302231454903657293676544, 179008321032837179237),
        (323785396923873853110053, 180279076840424334920),
        (2417851639229258349412352, 217367246968445146216),
        (18446744073709551616000000, 254851187510399214118),
        (19342813113834066795298816, 255726172904053113196),
        (58843763135715298048359199, 276249373136330654629),
        (154742504910672534362390528, 294085098839661080175),
        (216143327627921069199001055, 300249618208560438441),
        (897453093381394696338702132, 326510755660969433861),
        (1237940039285380274899124224, 332444024775269047155),
        (2401914366096376979074951948, 344670846473347769910),
        (7481275635688142686446958901, 365628879465179399337),
        (9903520314283042199192993792, 370802950710877014134),
        (39853377205144676775454522712, 396486663650709230838),
        (79228162514264337593543950336, 409161876646484981113),
        (81526887023429096557531547312, 409689472804827966189),
        (89736774747577300789847262920, 411459397167705590760),
        (126168017215988631632058148650, 417744826903003583074),
        (633825300114114700748351602688, 447520802582092948093),
        (2205831318422906450804174841276, 470525485639167187383),
        (2874467447944870189969160736544, 475409500360932007864),
        (3193606911412049701242265805857, 477351639057116268531),
        (5070602400912917605986812821504, 485879728517700915072),
        (18446744073709551616000000000000, 509702375020798428236),
        (18541416771709711164096151617637, 509796805606401021040),
        (40564819207303340847894502572032, 524238654453308882051),
        (73514616815689234193485558188273, 535206776466048273074),
        (116010899407681161438303209200624, 543622179127892911283),
        (138746081609275154208422529810224, 546923433617361900458),
        (160666921790506217201557863135286, 549629347799008861996),
        (295240597492848018643869470937556, 560853401961693828861),
        (324518553658426726783156020576256, 562597580388916849031),
        (649132778335444976683614842321469, 575386607967624170298),
        (939715850916456751485121794684264, 582210801237148505164),
        (1485567477440605958743116444445877, 590658941007492506304),
        (2596148429267413814265248164610048, 600956506324524816010),
        (2973295495258936962396378246733996, 603458658822000127659),
        (8486605086391376337289354822905284, 622805938192912260960),
        (15854592887887520287525155795307986, 634334603196539700954),
        (16080074878440861773205062178216343, 634595102396114842680),
        (18446744073709551616000000000000000, 637127968775998035295),
        (20769187434139310514121985316880384, 639315432260132782989),
        (70229200066203076812136753701266297, 661788983702705008789),
        (143450340186851810042233874377850675, 674964104581650728693),
        (166153499473114484112975882535043072, 677674358195740749969),
        (1329227995784915872903807060280344576, 716033284131348716948),
        (1869731139992975150102576580695697426, 722327245430743992844),
        (2924876492801429208630470455139103776, 730581381445953800096),
        (3594161164495549126180207710676101291, 734382487551980265312),
        (4994463751637702934595504433494399761, 740451824575063887412),
        (10633823966279326983230456482242756608, 754392210066956683928),
        (25219205371966858774408646877457635188, 770322190342145293321),
        (42726886077701378771430297765115721042, 780047729799840604341),
        (85070591730234615865843651857942052864, 792751136002564650907),
        (170141183460469231731687303715884105727, 805537444647767306567),
    ];

    const EXPM1_GOLDEN: &[(i128, i128)] = &[
        (-828258808909558867558, -18446744073709551615),
        (-811656739243220271104, -18446744073709551615),
        (-799826954110525467029, -18446744073709551613),
        (-762285487759993737417, -18446744073709551595),
        (-738022987535197171529, -18446744073709551538),
        (-737869762948382064640, -18446744073709551538),
        (-730958705411911474529, -18446744073709551502),
        (-715062232868666255160, -18446744073709551346),
        (-703138949057257685031, -18446744073709551101),
        (-701007177332981070886, -18446744073709551038),
        (-700192740309347770879, -18446744073709551012),
        (-681382955015342335684, -18446744073709549941),
        (-673729222287881527159, -18446744073709549080),
        (-644787256964811562221, -18446744073709539437),
        (-640533301917072909300, -18446744073709536279),
        (-616112625795614266001, -18446744073709493981),
        (-559106466490216132043, -18446744073708284572),
        (-553402322211286548480, -18446744073707825439),
        (-526486341459312828471, -18446744073702125320),
        (-523127196610473768811, -18446744073700642038),
        (-521009838803357941784, -18446744073699558374),
        (-506589228638191835379, -18446744073687713609),
        (-496521789311800479601, -18446744073671861086),
        (-482942560381745900933, -18446744073630859707),
        (-467984966971381705329, -18446744073532508534),
        (-462232729497717374268, -18446744073467724634),
        (-443524904757484243583, -18446744073042827905),
        (-414051546911555413931, -18446744070414656340),
        (-406929120981296893011, -18446744068861960676),
        (-395193866517025652599, -18446744064551336647),
        (-394839441814504526691, -18446744064373674906),
        (-380977614489995827179, -18446744053916798747),
        (-368934881474191032320, -18446744035687978246),
        (-360280714566063890439, -18446744012927347721),
        (-359399457955971437224, -18446744009953120220),
        (-338558042740117729293, -18446743876377974520),
        (-322737310956241455576, -18446743608480887807),
        (-297578670372788297693, -18446742254091905017),
        (-293183121331773797618, -18446741764490058413),
        (-281532394271845168172, -18446739731007420708),
        (-265633522940606282158, -18446733791899628921),
        (-247080355824419754657, -18446715963143780924),
        (-240100097589981736711, -18446703033756009139),
        (-230093258532856754705, -18446673474573928307),
        (-222092729518265378641, -18446635141315901129),
        (-197408289324315911262, -18446328826664538571),
        (-184467440737095516160, -18445906592824258669),
        (-179087153468267748537, -18445622975086237622),
        (-173751749565275720853, -18445246955684567655),
        (-168050296568595029067, -18444704749813129854),
        (-167589931966355205420, -18444653215214760114),
        (-148469638768294802043, -18440849171672435276),
        (-103810642090385164959, -18380386561397921194),
        (-92233720368547758080, -18322450889835202718),
        (-54180694466225809970, -17468751742629096190),
        (-52587937232159335339, -17380555623945943571),
        (-36893488147419103232, -15950248739700762816),
        (-18446744073709551616, -11660566172440666341),
        (-14191561002955487253, -9899902411900339880),
        (-11068046444225730970, -8322956278009226466),
        (-9407839477591871324, -7369555813965597848),
        (-9223372036854775808, -7258228221132386316),
        (-9038904596117680292, -7145781767390122779),
        (-7378697629483820646, -6081521737012908526),
        (-4611686018427387904, -4080405343986755773),
        (-4532256930551354077, -4018412537775097879),
        (-1844674407370955162, -1755439794884062207),
        (-1152921504606846976, -1117631724489728397),
        (-184467440737095516, -183548170319958995),
        (-72057594037927936, -71917039622693319),
        (-18446744073709552, -18437523775361582),
        (-4503599627370496, -4503049916293120),
        (-281474976710656, -281472829237931),
        (-18446744073710, -18446734850341),
        (-17592186044416, -17592177655811),
        (-1099511627776, -1099511595008),
        (-1095627790995, -1095627758458),
        (-1063708498820, -1063708468151),
        (-1056588002542, -1056587972283),
        (-1045091760959, -1045091731354),
        (-1031306226058, -1031306197229),
        (-1024019295521, -1024019267098),
        (-1012573815768, -1012573787977),
        (-943885633168, -943885609020),
        (-918518214626, -918518191758),
        (-892426310971, -892426289384),
        (-855639584306, -855639564462),
        (-851893610517, -851893590846),
        (-844233551786, -844233532467),
        (-763456201437, -763456185638),
        (-701235065454, -701235052126),
        (-696209091353, -696209078215),
        (-686405462691, -686405449920),
        (-661962592523, -661962580646),
        (-629694935033, -629694924285),
        (-619734004733, -619733994323),
        (-547034680073, -547034671962),
        (-460781340154, -460781334399),
        (-442688060576, -442688055264),
        (-400867402106, -400867397750),
        (-397341578184, -397341573905),
        (-342868103258, -342868100072),
        (-326728841651, -326728838757),
        (-292596103402, -292596101081),
        (-289160513919, -289160511653),
        (-288758921586, -288758919326),
        (-263062343190, -263062341314),
        (-239292321770, -239292320218),
        (-151326483430, -151326482809),
        (-114335438117, -114335437763),
        (-107754988772, -107754988457),
        (-102444689073, -102444688789),
        (-90273047107, -90273046886),
        (-68719476736, -68719476608),
        (-46528031097, -46528031038),
        (-37911657373, -37911657334),
        (-5476979272, -5476979271),
        (-4294967296, -4294967296),
        (-1844674407, -1844674407),
        (-268435456, -268435456),
        (-16777216, -16777216),
        (-1048576, -1048576),
        (-65536, -65536),
        (-4096, -4096),
        (-256, -256),
        (-16, -16),
        (-1, -1),
        (0, 0),
    ];
    // __GOLDEN_END__

    /// Deterministic 64-bit LCG so the fuzz sweeps need no dev-dependency.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            self.0
        }
        fn next_i128(&mut self) -> i128 {
            let hi = self.next() as u128;
            let lo = self.next() as u128;
            (((hi << 64) | lo) >> 1) as i128
        }
    }

    /// Absolute distance in raw units, overflow-free even for `MIN`/`MAX`.
    fn ulps(a: i128, b: i128) -> u128 {
        if a >= b {
            a.wrapping_sub(b) as u128
        } else {
            b.wrapping_sub(a) as u128
        }
    }

    // -- constants --------------------------------------------------------

    #[test]
    fn constants_are_correctly_rounded() {
        assert_eq!(Fixed::ONE.to_raw(), 1i128 << 64);
        assert_eq!(Fixed::LN_2.to_raw(), 12_786_308_645_202_655_660);
        assert_eq!(Fixed::E.to_raw(), 50_143_449_209_799_256_683);
        assert_eq!(Fixed::SQRT_2.to_raw(), 26_087_635_650_665_564_425);
        // Cross-check against f64 to catch a transposed digit.
        assert!((Fixed::LN_2.to_f64() - core::f64::consts::LN_2).abs() < 1e-15);
        assert!((Fixed::E.to_f64() - core::f64::consts::E).abs() < 1e-15);
        assert!((Fixed::SQRT_2.to_f64() - core::f64::consts::SQRT_2).abs() < 1e-15);
    }

    // -- conversions ------------------------------------------------------

    #[test]
    fn conversions_round_trip() {
        for n in [0i64, 1, 2, -1, -7, 1_000_000, 1_000_000_000_000_000, i64::MAX, i64::MIN] {
            assert_eq!(Fixed::from_int(n).to_int_floor(), n);
        }
        for n in [0u64, 1, 999_999, 1_000_000, 1_000_000_000_000_000] {
            let f = Fixed::from_base_units(n).expect("in range");
            assert_eq!(f.to_base_units_floor(), Ok(n));
            assert_eq!(f.to_base_units_ceil(), Ok(n));
        }
        assert_eq!(Fixed::from_base_units(u64::MAX), Err(FixedError::Overflow));

        // floor vs ceil on a fraction
        let half = Fixed::ONE.checked_div(Fixed::from_int(2)).unwrap();
        let three_halves = Fixed::from_int(1).checked_add(half).unwrap();
        assert_eq!(three_halves.to_int_floor(), 1);
        assert_eq!(three_halves.to_int_ceil(), Ok(2));
        assert_eq!(three_halves.to_base_units_floor(), Ok(1));
        assert_eq!(three_halves.to_base_units_ceil(), Ok(2));

        // negatives floor downwards, and are rejected as unsigned
        let neg = Fixed::from_int(-1).checked_sub(half).unwrap();
        assert_eq!(neg.to_int_floor(), -2);
        assert_eq!(neg.to_int_ceil(), Ok(-1));
        assert_eq!(neg.to_base_units_floor(), Err(FixedError::Domain));

        // ratios
        assert_eq!(Fixed::from_ratio(1, 2), Ok(Fixed(ONE / 2)));
        assert_eq!(Fixed::from_ratio(-1, 2), Ok(Fixed(-ONE / 2)));
        assert_eq!(Fixed::from_ratio(1, -2), Ok(Fixed(-ONE / 2)));
        assert_eq!(Fixed::from_ratio(1, 0), Err(FixedError::DivByZero));
        // The LMSR's actual q/b corner: MAX_Q / B_MIN = 1e8.
        let r = Fixed::from_ratio(1_000_000_000_000_000, 10_000_000).unwrap();
        assert_eq!(r.to_int_floor(), 100_000_000);
    }

    // -- wide multiply / divide -------------------------------------------

    #[test]
    fn wide_mul_matches_schoolbook() {
        let mut rng = Lcg(0xC0FFEE);
        for _ in 0..20_000 {
            let a = rng.next() as u128 | ((rng.next() as u128) << 64);
            let b = rng.next() as u128 | ((rng.next() as u128) << 64);
            let (hi, lo) = wide_mul(a, b);
            // Verify by re-deriving with 64-bit limbs the other way round.
            let (hi2, lo2) = wide_mul(b, a);
            assert_eq!((hi, lo), (hi2, lo2));
            // a*1 == a
            assert_eq!(wide_mul(a, 1), (0, a));
            // low 128 bits must agree with wrapping_mul
            assert_eq!(lo, a.wrapping_mul(b));
        }
    }

    #[test]
    fn mul_div_are_inverse_within_one_ulp() {
        let mut rng = Lcg(0xBEEF);
        for _ in 0..20_000 {
            let a = Fixed(rng.next_i128() >> 32);
            let b = Fixed((rng.next_i128() >> 40) | 1);
            if b.is_zero() {
                continue;
            }
            if let Some(q) = a.checked_div(b) {
                if let Some(back) = q.checked_mul(b) {
                    // truncation twice ⇒ at most a couple of ulps of |b| slack
                    let slack = b.checked_abs().unwrap().to_raw().max(4);
                    assert!(
                        ulps(back.to_raw(), a.to_raw()) <= slack as u128,
                        "a={:?} b={:?} q={:?} back={:?}",
                        a,
                        b,
                        q,
                        back
                    );
                }
            }
        }
    }

    #[test]
    fn mul_uses_full_256_bit_intermediate() {
        // 2^40 * 2^40 = 2^80: the raw i128 product is 2^208, which would wrap a
        // naive i128 multiply.
        let a = Fixed::from_int(1 << 40);
        let b = Fixed::from_int(1 << 40);
        // 2^80 does not fit the 64 integer bits -> must be a clean overflow.
        assert_eq!(a.checked_mul(b), None);
        // 2^31 * 2^31 = 2^62 does fit, and the intermediate is still 2^190.
        let c = Fixed::from_int(1 << 31);
        assert_eq!(
            c.checked_mul(c).map(|v| v.to_int_floor()),
            Some(1i64 << 62)
        );
        // sign handling
        assert_eq!(
            Fixed::from_int(-3).checked_mul(Fixed::from_int(5)),
            Some(Fixed::from_int(-15))
        );
    }

    #[test]
    fn division_by_zero_never_panics() {
        assert_eq!(Fixed::ONE.checked_div(Fixed::ZERO), None);
        assert_eq!(Fixed::MIN.checked_div(Fixed::ZERO), None);
        assert_eq!(Fixed::ZERO.checked_div(Fixed::ZERO), None);
        assert_eq!(Fixed::from_ratio(5, 0), Err(FixedError::DivByZero));
        // i128::MIN / -1 is the classic native-division panic; we must not.
        assert_eq!(Fixed::MIN.checked_div(Fixed::NEG_ONE), None);
        assert_eq!(Fixed::MIN.checked_neg(), None);
        assert_eq!(Fixed::MIN.checked_abs(), None);
        assert_eq!(Fixed::MIN.checked_mul(Fixed::from_int(-1)), None);
    }

    // -- known values -----------------------------------------------------

    #[test]
    fn known_values() {
        assert_eq!(Fixed::ZERO.exp(), Ok(Fixed::ONE));
        // exp(-ln2) is exactly 1/2 by construction of the range reduction.
        assert_eq!(Fixed::LN_2.checked_neg().unwrap().exp(), Ok(Fixed(ONE / 2)));
        assert_eq!(Fixed::ONE.ln(), Ok(Fixed::ZERO));
        // ln(2) is exactly the constant, again by construction.
        assert_eq!(Fixed::from_int(2).ln(), Ok(Fixed::LN_2));
        assert_eq!(Fixed::from_int(4).ln(), Ok(Fixed(2 * LN_2_RAW)));
        assert_eq!(Fixed(ONE / 2).ln(), Ok(Fixed(-LN_2_RAW)));

        let ln_e = Fixed::E.ln().unwrap();
        assert!(
            ulps(ln_e.to_raw(), ONE) <= 8,
            "ln(e) off by {} ulp",
            ulps(ln_e.to_raw(), ONE)
        );
        assert_eq!(Fixed::ZERO.expm1(), Ok(Fixed::ZERO));
    }

    #[test]
    fn ln_domain_errors_never_panic() {
        assert_eq!(Fixed::ZERO.ln(), Err(FixedError::Domain));
        assert_eq!(Fixed::NEG_ONE.ln(), Err(FixedError::Domain));
        assert_eq!(Fixed::MIN.ln(), Err(FixedError::Domain));
        assert_eq!(Fixed(-1).ln(), Err(FixedError::Domain));
        // smallest positive value is fine
        let tiny = Fixed(1).ln().unwrap();
        assert!(tiny.is_negative());
        assert_eq!(tiny.to_raw(), -64 * LN_2_RAW);
        // largest representable value is fine
        assert!(Fixed::MAX.ln().is_ok());
    }

    // -- underflow / overflow ---------------------------------------------

    #[test]
    fn exp_underflows_to_zero_not_an_error() {
        // The real LMSR corner: (q_min - q_max)/b = -1e8 at q=MAX_Q, b=B_MIN.
        let deep = Fixed::from_ratio(-1_000_000_000_000_000, 10_000_000).unwrap();
        assert_eq!(deep.to_int_floor(), -100_000_000);
        assert_eq!(deep.exp(), Ok(Fixed::ZERO));
        assert_eq!(deep.expm1(), Ok(Fixed::NEG_ONE));

        assert_eq!(Fixed::MIN.exp(), Ok(Fixed::ZERO));
        assert_eq!(Fixed::MIN.expm1(), Ok(Fixed::NEG_ONE));
        assert_eq!(Fixed::from_int(-45).exp(), Ok(Fixed::ZERO));
        assert_eq!(Fixed::from_int(-138).exp(), Ok(Fixed::ZERO));
        // just above the cut-off the result is still a positive ulp count
        assert!(Fixed::from_int(-44).exp().unwrap().is_positive());
        // the true boundary: exp(-44.4) ≈ 5.75e-20 ≈ 1.06 ulp
        let b = Fixed(-(44 * ONE) - (2 * ONE) / 5).exp().unwrap();
        assert_eq!(b.to_raw(), 1);
    }

    #[test]
    fn exp_overflow_is_an_error() {
        assert_eq!(Fixed::MAX.exp(), Err(FixedError::Overflow));
        assert_eq!(Fixed::from_int(45).exp(), Err(FixedError::Overflow));
        assert_eq!(Fixed::from_int(44).exp(), Err(FixedError::Overflow));
        // ln(2^63) = 43.668...; 43 must still succeed.
        assert!(Fixed::from_int(43).exp().is_ok());
        assert!(Fixed::from_int(1).exp().is_ok());
    }

    // -- golden accuracy --------------------------------------------------

    /// Absolute error in ulps is the primary bound: it is what survives the
    /// `b · ln(·)` scaling in the LMSR. A *relative* bound is only meaningful
    /// where the result itself is large enough for Q64.64 to carry relative
    /// precision at all, so it is measured over `|result| ≥ 1/2` (raw `≥ 2^63`)
    /// — below that the format, not the algorithm, sets the floor
    /// (`rel = abs / |result|`; see the module doc).
    const REL_FLOOR_RAW: i128 = 1i128 << 63;

    fn rel_err(got: i128, want: i128) -> f64 {
        if want == 0 {
            return 0.0;
        }
        (ulps(got, want) as f64) / (want.unsigned_abs() as f64)
    }

    #[test]
    fn exp_matches_golden_table() {
        let mut max_ulp = 0u128;
        let mut max_rel = 0.0f64;
        for &(x, want) in EXP_GOLDEN {
            let got = Fixed(x).exp().expect("golden args are in range").to_raw();
            let u = ulps(got, want);
            if u > max_ulp {
                max_ulp = u;
            }
            if want.unsigned_abs() >= REL_FLOOR_RAW as u128 {
                let r = rel_err(got, want);
                if r > max_rel {
                    max_rel = r;
                }
            }
        }
        println!("exp: max abs error {} ulp, max rel error {:.3e}", max_ulp, max_rel);
        assert!(max_ulp <= 3, "exp abs error {} ulp exceeds documented 3", max_ulp);
        assert!(max_rel <= 5.0e-19, "exp rel error {:.3e} exceeds documented 5.0e-19", max_rel);
    }

    #[test]
    fn ln_matches_golden_table() {
        let mut max_ulp = 0u128;
        let mut max_rel = 0.0f64;
        for &(x, want) in LN_GOLDEN {
            let got = Fixed(x).ln().expect("golden args are positive").to_raw();
            let u = ulps(got, want);
            if u > max_ulp {
                max_ulp = u;
            }
            if want.unsigned_abs() >= REL_FLOOR_RAW as u128 {
                let r = rel_err(got, want);
                if r > max_rel {
                    max_rel = r;
                }
            }
        }
        println!("ln:  max abs error {} ulp, max rel error {:.3e}", max_ulp, max_rel);
        assert!(max_ulp <= 20, "ln abs error {} ulp exceeds documented 20", max_ulp);
        assert!(max_rel <= 5.0e-19, "ln rel error {:.3e} exceeds documented 5.0e-19", max_rel);
    }

    #[test]
    fn expm1_matches_golden_table() {
        let mut max_ulp = 0u128;
        let mut max_rel = 0.0f64;
        for &(x, want) in EXPM1_GOLDEN {
            let got = Fixed(x).expm1().expect("golden args are in range").to_raw();
            let u = ulps(got, want);
            if u > max_ulp {
                max_ulp = u;
            }
            if want.unsigned_abs() >= REL_FLOOR_RAW as u128 {
                let r = rel_err(got, want);
                if r > max_rel {
                    max_rel = r;
                }
            }
        }
        println!("expm1: max abs error {} ulp, max rel error {:.3e}", max_ulp, max_rel);
        assert!(max_ulp <= 3, "expm1 abs error {} ulp exceeds documented 3", max_ulp);
        assert!(max_rel <= 5.0e-19, "expm1 rel error {:.3e} exceeds documented 5.0e-19", max_rel);
    }

    /// `expm1` must beat `exp(x) - 1` where it matters: tiny arguments.
    #[test]
    fn expm1_is_accurate_for_tiny_arguments() {
        // X/b at the extreme: 1 base unit of collateral against b = B_MAX.
        let t = Fixed::from_ratio(-1, 1_000_000_000_000).unwrap();
        let e = t.expm1().unwrap();
        // expm1(-1e-12) = -1e-12 + 5e-25 - ...; in Q64.64 that is -t to the ulp.
        assert!(ulps(e.to_raw(), t.to_raw()) <= 2, "got {:?} want ~{:?}", e, t);
        assert!(e.is_negative());
        // and the naive form is exactly as bad as advertised (loses everything
        // below 1 ulp of 1.0, which here is the whole answer's low bits)
        let naive = t.exp().unwrap().checked_sub(Fixed::ONE).unwrap();
        assert!(ulps(naive.to_raw(), t.to_raw()) >= ulps(e.to_raw(), t.to_raw()));
    }

    // -- accuracy vs f64 (independent of the golden tables) ----------------

    #[test]
    fn accuracy_vs_f64() {
        let mut max_rel_exp = 0.0f64;
        let mut max_rel_ln = 0.0f64;
        // exp over [-40, 0]: below that the f64 comparison is dominated by
        // Q64.64's own absolute resolution, not by either implementation.
        for i in 0..=4000 {
            let x = -(i as f64) * 0.01;
            let raw = (x * 18_446_744_073_709_551_616.0) as i128;
            let got = Fixed(raw).exp().unwrap().to_f64();
            let want = Fixed(raw).to_f64().exp();
            if want > 1e-3 {
                let r = ((got - want) / want).abs();
                if r > max_rel_exp {
                    max_rel_exp = r;
                }
            }
        }
        // ln over 2^-40 .. 2^40
        for i in -4000..=4000 {
            let x = (i as f64) * 0.01;
            let v = x.exp();
            let raw = (v * 18_446_744_073_709_551_616.0) as i128;
            if raw <= 0 {
                continue;
            }
            let got = Fixed(raw).ln().unwrap().to_f64();
            let want = Fixed(raw).to_f64().ln();
            if want.abs() > 1e-9 {
                let r = ((got - want) / want).abs();
                if r > max_rel_ln {
                    max_rel_ln = r;
                }
            }
        }
        println!(
            "vs f64: exp max rel {:.3e}, ln max rel {:.3e} (f64 itself is only good to 1.1e-16)",
            max_rel_exp, max_rel_ln
        );
        assert!(max_rel_exp < 1e-14);
        assert!(max_rel_ln < 1e-14);
    }

    // -- round trip -------------------------------------------------------

    #[test]
    fn ln_of_exp_round_trips_across_the_negative_domain() {
        // `ln(exp(x))` cannot beat the quantisation of the intermediate:
        // `exp(x)` is stored to 1 ulp, and `d ln / d e = 1/e`, so an error of
        // `1/exp(x)` ulps in the recovered `x` is the format's floor, not the
        // algorithm's. The assertion is therefore against that floor, and the
        // headline number is reported over the band where it is 1.
        let mut worst_ratio = 0.0f64;
        let mut worst_shallow = 0u128;
        for i in 0..=45_000i128 {
            let x = -(i * ONE) / 1000; // 0 .. -45 in 0.001 steps
            let e = Fixed(x).exp().unwrap();
            if e.is_zero() {
                continue;
            }
            let back = e.ln().unwrap();
            let d = ulps(back.to_raw(), x);
            let quant = (ONE_RAW as u128) / e.to_raw().unsigned_abs().max(1) + 40;
            assert!(d <= quant, "x={} d={} allowed={}", x, d, quant);
            let ratio = d as f64 / quant as f64;
            if ratio > worst_ratio {
                worst_ratio = ratio;
            }
            // -20 .. 0: exp(x) still has >35 significant bits.
            if x >= -20 * ONE && d > worst_shallow {
                worst_shallow = d;
            }
        }
        println!(
            "ln(exp(x)): worst {} ulp over x in [-20,0]; worst fraction of the \
             format's own quantisation floor over [-45,0]: {:.3}",
            worst_shallow, worst_ratio
        );
    }

    #[test]
    fn exp_of_ln_round_trips() {
        for i in 1..=2000i128 {
            let v = Fixed((i * ONE) / 100); // 0.01 .. 20
            let back = v.ln().unwrap().exp().unwrap();
            let tol = (v.to_raw().unsigned_abs() / (1u128 << 40)).max(64);
            assert!(
                ulps(back.to_raw(), v.to_raw()) <= tol,
                "v={:?} back={:?}",
                v,
                back
            );
        }
    }

    // -- monotonicity ------------------------------------------------------

    #[test]
    fn exp_is_monotone_across_a_dense_sweep() {
        let mut prev = Fixed::ZERO;
        // 0 .. -46 in 46_000 steps
        for i in (0..=46_000i128).rev() {
            let x = -(i * ONE) / 1000;
            let e = Fixed(x).exp().unwrap();
            assert!(
                e.to_raw() >= prev.to_raw(),
                "exp not monotone at x={} ({:?} < {:?})",
                x,
                e,
                prev
            );
            assert!(e.to_raw() >= 0 && e.to_raw() <= ONE);
            prev = e;
        }
        assert_eq!(prev, Fixed::ONE);
    }

    #[test]
    fn expm1_is_monotone_across_a_dense_sweep() {
        let mut prev = Fixed::NEG_ONE;
        for i in (0..=46_000i128).rev() {
            let x = -(i * ONE) / 1000;
            let e = Fixed(x).expm1().unwrap();
            assert!(e.to_raw() >= prev.to_raw(), "expm1 not monotone at x={}", x);
            assert!(e.to_raw() >= -ONE && e.to_raw() <= 0);
            prev = e;
        }
        assert_eq!(prev, Fixed::ZERO);
    }

    #[test]
    fn ln_is_monotone_across_a_dense_sweep() {
        // Geometric sweep over the whole positive range, 1 ulp .. MAX.
        let mut prev = i128::MIN;
        let mut x: i128 = 1;
        while x < i128::MAX / 3 {
            let l = Fixed(x).ln().unwrap().to_raw();
            assert!(l > prev, "ln not monotone at x={}", x);
            prev = l;
            x = x + (x >> 6) + 1;
        }
        // Linear sweep across the [1/2, 2] band where the mantissa reduction
        // switches branches.
        let mut prev = i128::MIN;
        for i in 1..=200_000i128 {
            let x = (i * ONE) / 100_000; // 1e-5 .. 2 in ulp-free steps
            let l = Fixed(x).ln().unwrap().to_raw();
            assert!(l > prev, "ln not monotone at x={}", x);
            prev = l;
        }
    }

    // -- boundary behaviour -------------------------------------------------

    #[test]
    fn extreme_inputs_never_panic() {
        let corners = [
            i128::MIN,
            i128::MIN + 1,
            i128::MAX,
            i128::MAX - 1,
            0,
            1,
            -1,
            ONE,
            -ONE,
            i64::MAX as i128,
            i64::MIN as i128,
            1i128 << 126,
            -(1i128 << 126),
        ];
        for &a in corners.iter() {
            let fa = Fixed(a);
            // must not panic; result may be an error
            let _ = fa.exp();
            let _ = fa.expm1();
            let _ = fa.ln();
            let _ = fa.to_int_floor();
            let _ = fa.to_int_ceil();
            let _ = fa.to_base_units_floor();
            let _ = fa.to_base_units_ceil();
            let _ = fa.checked_neg();
            let _ = fa.checked_abs();
            for &b in corners.iter() {
                let fb = Fixed(b);
                let _ = fa.checked_add(fb);
                let _ = fa.checked_sub(fb);
                let _ = fa.checked_mul(fb);
                let _ = fa.checked_mul_nearest(fb);
                let _ = fa.checked_div(fb);
                let _ = Fixed::from_ratio(a, b);
            }
        }
    }

    #[test]
    fn fuzz_never_panics_and_respects_ranges() {
        let mut rng = Lcg(0x5EED);
        for _ in 0..100_000 {
            let a = rng.next_i128().wrapping_sub(rng.next_i128());
            let b = rng.next_i128().wrapping_sub(rng.next_i128());
            let fa = Fixed(a);
            let fb = Fixed(b);
            let _ = fa.checked_add(fb);
            let _ = fa.checked_sub(fb);
            let _ = fa.checked_mul(fb);
            let _ = fa.checked_div(fb);
            let _ = Fixed::from_ratio(a, b);
            let _ = fa.to_int_ceil();
            let _ = fa.to_base_units_ceil();

            // exp on the negative half must always succeed and land in [0, 1]
            let neg = Fixed(if a > 0 { -a } else { a });
            let e = neg.exp().expect("exp(x<=0) is always defined");
            assert!(e.to_raw() >= 0 && e.to_raw() <= ONE);
            let m = neg.expm1().expect("expm1(x<=0) is always defined");
            assert!(m.to_raw() >= -ONE && m.to_raw() <= 0);

            // ln is defined exactly on the positive half
            if a > 0 {
                assert!(fa.ln().is_ok());
            } else {
                assert_eq!(fa.ln(), Err(FixedError::Domain));
            }
        }
    }

    /// The property T03's log-sum-exp form leans on: with both exponents `≤ 0`
    /// and the larger one exactly `0`, `S = 1 + exp(δ)` is always in `[1, 2]`
    /// and can never overflow, however extreme the skew.
    #[test]
    fn log_sum_exp_shape_cannot_overflow() {
        let mut rng = Lcg(0xD4);
        for _ in 0..20_000 {
            let d = -(rng.next_i128() % (200 * ONE)).abs();
            let u = Fixed(d).exp().unwrap();
            let s = Fixed::ONE.checked_add(u).expect("S <= 2 always fits");
            assert!(s.to_raw() >= ONE && s.to_raw() <= 2 * ONE);
            let ln_s = s.ln().unwrap();
            assert!(ln_s.to_raw() >= 0 && ln_s.to_raw() <= LN_2_RAW);
        }
    }

    /// `b · ln(S)` is the max-loss quantity; at `q_yes == q_no` it must equal
    /// `b · ln 2` to well under one base unit for every legal `b`.
    #[test]
    fn b_ln_2_is_exact_to_far_below_one_base_unit() {
        for b in [
            10_000_000u64,
            100_000_000,
            1_000_000_000,
            10_000_000_000,
            100_000_000_000,
            1_000_000_000_000,
        ] {
            let bf = Fixed::from_base_units(b).unwrap();
            let s = Fixed::ONE.checked_add(Fixed::ZERO.exp().unwrap()).unwrap();
            let c = bf.checked_mul(s.ln().unwrap()).unwrap();
            let exact = bf.checked_mul(Fixed::LN_2).unwrap();
            assert_eq!(c, exact);
            // and against f64
            let want = (b as f64) * core::f64::consts::LN_2;
            assert!((c.to_f64() - want).abs() < 1e-3, "b={} c={}", b, c.to_f64());
        }
    }
}
