//! The public LMSR market-maker API, in integer base units.
//!
//! Every argument and every return value is a plain `u64` count of 6-decimal
//! base units ([`UNIT`] base units = 1 USDC = 1 share). Q64.64 is an internal
//! representation only; it never crosses this boundary. The reference
//! implementation this module must agree with is `reference/lmsr_ref.py`.
//!
//! # Numerical form
//!
//! The cost function is **never** evaluated as `b·ln(e^(q_y/b) + e^(q_n/b))`.
//! It is always evaluated in the log-sum-exp stabilised form of
//! `docs/DESIGN_DECISIONS.md` D4:
//!
//! ```text
//! m   = max(q_yes, q_no)
//! u_i = exp((q_i − m) / b)   ∈ (0, 1]
//! C   = m + b · ln(u_yes + u_no)
//! ```
//!
//! Both exponents are `≤ 0`, so neither `exp` can overflow however large `q` is
//! or however small `b` is, and `S = u_yes + u_no ∈ [1, 2]` always — which is
//! also what keeps `b · ln(S)` accurate (see "Precision" below).
//!
//! # Rounding policy (frozen — matches `reference/lmsr_ref.py` exactly)
//!
//! Money never rounds in the user's favour, or the vault drains over many small
//! trades.
//!
//! | function | direction |
//! |---|---|
//! | [`cost`] | floor |
//! | [`price_yes`] | floor of `p · UNIT` |
//! | [`price_no`] | **`UNIT − price_yes`**, defined as the complement |
//! | [`buy_cost`] | **ceil** |
//! | [`sell_return`] | **floor** |
//! | [`shares_for_cost`] | floor |
//! | [`max_loss_bound`] | ceil (it is an upper bound) |
//!
//! [`buy_cost`] and [`sell_return`] round the **exact trade difference once**.
//! They are *not* `cost(new) − cost(old)` on already-rounded costs, nor even a
//! raw subtraction of two `~1e15`-magnitude values — that would lose the answer
//! to cancellation. They evaluate
//!
//! ```text
//! ΔC = (m_new − m_old) + b · ln(S_new / S_old)
//! ```
//!
//! where `m_new − m_old` is an exact integer and `S_new / S_old` is a ratio of
//! two numbers in `[1, 2]`.
//!
//! # Precision
//!
//! `b · ln(z)` carries an absolute error of roughly `b · abs_err(z) / z`. With
//! `z = S ∈ [1, 2]` that is under `1e-6` base units even at `b = B_MAX`, which
//! is why [`cost`], [`price_yes`], [`buy_cost`] and [`sell_return`] can be
//! written straight from the formulas above.
//!
//! [`shares_for_cost`] cannot. Its natural form takes `ln` of
//! `u_out + u_other·(1 − e^(−X/b))`, which becomes far smaller than `1` at deep
//! skew or for a small spend, and the amplification above then reaches
//! `1.6e5` base units on real vector cases (e.g. `q_yes = 1e15 − 1`,
//! `b = B_MAX`, spend 1 base unit). It is therefore evaluated entirely in the
//! log domain — see the derivation on [`shares_for_cost`] — so that every
//! logarithm this crate takes has an argument in `[1, 2]`, and every quantity
//! that would have been a near-denormal `Fixed` is instead carried as an exact
//! integer or as its logarithm.
//!
//! # Agreement with the reference oracle — measured
//!
//! Every one of T01's 3,988 committed vectors was run through this module.
//! `q`/`b`/skew below are `|q_yes − q_no| / b`.
//!
//! | function | checks | disagreements | first at skew |
//! |---|---:|---:|---:|
//! | [`cost`] | 1,587 | **0** | — |
//! | [`price_yes`] | 1,587 | 36 | 59 |
//! | [`buy_cost`] | 1,249 | 4 | 59.75 |
//! | [`sell_return`] | 890 | 1 | 92 |
//! | [`shares_for_cost`] | 1,212 | 34 (12 of them `exceeds_max_q`) | 500 |
//!
//! **Every disagreement is exactly ±1 base unit (1e-6 USDC) and every one is at
//! a skew above 59**, i.e. a price beyond `1 − 1e-25`. Below that skew the two
//! implementations agree on every committed vector, exactly.
//!
//! The cause is not an error in either implementation: at those skews the exact
//! result sits infinitesimally below (or above) an integer, and the two
//! arithmetics disagree about which side of it they are on. `mpmath` at 60
//! decimal digits still carries the minority weight `e^-skew`; Q64.64 cannot —
//! one ulp is `2^-64 ≈ 5.4e-20`, and even after the pre-scaling in
//! [`b_small_softplus`] the weight vanishes past `skew ≈ 45 + ln b`. T01
//! anticipated this and emitted an unrounded `*_exact` field on every vector so
//! that T04 can compare with a tolerance rather than demanding integer
//! equality.
//!
//! Nothing solvency-relevant is lost. Over the full vector set:
//! `buy_cost` of every `shares_for_cost` answer is affordable (0 failures in
//! 1,212), and no buy-then-immediately-sell round trip profits (0 in 1,249).
//!
//! # Behaviours that are correct, not bugs
//!
//! * **Zero-cost trades exist at extreme skew.** When `(q_min − q_max)/b < −138`
//!   the exact cost of a small trade is below `1e-60`, and `ceil` of that is
//!   `0`. There is deliberately no `max(1, …)` floor here; a spam guard, if one
//!   is wanted, belongs in the program (T07).
//! * **[`shares_for_cost`] is not clamped to [`MAX_Q`](crate::bounds::MAX_Q).** At extreme skew the
//!   near-worthless side is nearly free, so a small spend can legitimately buy
//!   more shares than the protocol allows to exist. This returns the
//!   mathematical answer; enforcing the cap is the caller's job.
//! * **At `q_yes = MAX_Q, b = B_MIN`, `cost` is exactly `q_yes` and
//!   `price_yes` is exactly `UNIT`.** `exp(−1e8)` underflows every
//!   representable format; that is the correct limit.

use crate::bounds::{validate_b, validate_q, UNIT};
use crate::error::{LmsrError, Result};
use crate::fixed::Fixed;

/// `UNIT` as a Q64.64 value (`1000000.0`).
const UNIT_FIXED: Fixed = Fixed::from_int(UNIT as i64);

/// `0.5` in Q64.64 — the cut-over between the two `ln(1 − e^(−t))` branches.
const HALF: Fixed = Fixed::from_raw(1i128 << 63);

/// Iteration cap for [`g_series`]. The series terminates on term underflow
/// after ~20 iterations for `t < 1/2`; the cap only guarantees termination.
const G_MAX_TERMS: u32 = 48;

/// Below this exponent the minority term `e^x` is small enough that
/// `ln(1 + u) = u − u²/2` is exact to well under an ulp, and the scaled
/// evaluation in [`b_small_softplus`] takes over. `e^-20 ≈ 2.06e-9`.
const TINY_X: Fixed = Fixed::from_int(-20);

/// `shares_for_cost` uses the direct form while its log argument is at least
/// this large; below it the amplification `b·err/arg` becomes visible and the
/// log-domain split takes over. At `arg = 1/4` and `b = B_MAX` the direct form
/// still carries under `1e-6` base units of error.
const NATURAL_MIN: Fixed = Fixed::from_raw(1i128 << 62);

/// Which side of a binary market a trade touches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum Outcome {
    /// The YES side, tracked by `q_yes`.
    Yes = 0,
    /// The NO side, tracked by `q_no`.
    No = 1,
}

impl Outcome {
    /// The opposite side.
    #[inline]
    pub const fn other(self) -> Self {
        match self {
            Outcome::Yes => Outcome::No,
            Outcome::No => Outcome::Yes,
        }
    }

    /// Select this side's quantity from a `(q_yes, q_no)` pair.
    #[inline]
    pub const fn select(self, q_yes: u64, q_no: u64) -> u64 {
        match self {
            Outcome::Yes => q_yes,
            Outcome::No => q_no,
        }
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// `C(q_yes, q_no) = b·ln(e^(q_yes/b) + e^(q_no/b))` in base units.
///
/// Rounded **down** (floor). Informational: this is the market's state
/// valuation, not a price a user pays.
///
/// # Errors
///
/// [`LmsrError::BOutOfRange`] / [`LmsrError::QOutOfRange`] for inputs outside
/// the frozen domain; [`LmsrError::Overflow`] can only arise from a bug, since
/// `C ≤ MAX_Q + B_MAX·ln 2 ≈ 1.0007e15`.
pub fn cost(q_yes: u64, q_no: u64, b: u64) -> Result<u64> {
    let c = cost_fixed(q_yes, q_no, b)?;
    Ok(c.to_base_units_floor()?)
}

/// YES price as a fraction of [`UNIT`] (`500_000` == `0.5`).
///
/// Rounded **down** (floor of `p · UNIT`), and clamped into `[0, UNIT]` so that
/// [`price_no`] can never go negative.
///
/// # Errors
///
/// As [`cost`].
pub fn price_yes(q_yes: u64, q_no: u64, b: u64) -> Result<u64> {
    check_state(q_yes, q_no, b)?;
    let (_m, x) = skew_terms(q_yes, q_no, b)?;
    let u = x.exp()?;
    // `s ≥ 1` always: the larger side's exponent is exactly 0, so its term is
    // exactly `Fixed::ONE`.
    let s = add(Fixed::ONE, u)?;

    // `UNIT · u_min`, evaluated as `exp(ln UNIT + x)` once `u` itself is small,
    // so the minority weight survives ~13.8 more units of skew than `u` does.
    let scaled_min = if x > TINY_X {
        mul(UNIT_FIXED, u)?
    } else {
        add(UNIT_FIXED.ln()?, x)?.exp()?
    };
    let minor = scaled_min.checked_div(s).ok_or(LmsrError::DivByZero)?;

    // The majority side is `UNIT − minor`; pick whichever side YES is on so
    // that the subtraction is never of two nearly equal large values.
    let p = if q_yes >= q_no {
        sub(UNIT_FIXED, minor)?
    } else {
        minor
    };
    let v = p.to_base_units_floor()?;
    Ok(if v > UNIT { UNIT } else { v })
}

/// NO price as a fraction of [`UNIT`], **defined** as `UNIT − price_yes`.
///
/// Deriving it rather than computing it independently is what makes
/// `price_yes + price_no == UNIT` hold *exactly* for every input; two
/// independent truncations would let the pair sum to `999_999`.
///
/// # Errors
///
/// As [`price_yes`].
pub fn price_no(q_yes: u64, q_no: u64, b: u64) -> Result<u64> {
    Ok(UNIT - price_yes(q_yes, q_no, b)?)
}

/// Collateral **in** to buy `shares` of `outcome`, rounded **up** (ceil).
///
/// Evaluated cancellation-free as `(m_new − m_old) + b·ln(S_new / S_old)`.
///
/// Returns `0` for `shares == 0`, and legitimately returns `0` for a tiny buy
/// of a near-worthless side at extreme skew (see the module docs).
///
/// # Errors
///
/// [`LmsrError::QOutOfRange`] if the buy would push that side past
/// [`MAX_Q`](crate::bounds::MAX_Q) (matching the oracle), plus the usual domain
/// errors.
pub fn buy_cost(q_yes: u64, q_no: u64, b: u64, outcome: Outcome, shares: u64) -> Result<u64> {
    check_state(q_yes, q_no, b)?;
    if shares == 0 {
        return Ok(0);
    }
    let (n_yes, n_no) = apply(q_yes, q_no, outcome, shares, true)?;
    validate_q(n_yes)?;
    validate_q(n_no)?;
    let d = delta_cost(q_yes, q_no, n_yes, n_no, b)?;
    if d.is_negative() {
        // Mathematically impossible (`C` is increasing in each `q`); a sub-ulp
        // negative can only come from rounding, and `ceil` of it is 0 anyway.
        return Ok(0);
    }
    Ok(d.to_base_units_ceil()?)
}

/// Collateral **out** for selling `shares` of `outcome`, rounded **down**
/// (floor).
///
/// Evaluated cancellation-free as `(m_old − m_new) + b·ln(S_old / S_new)`.
///
/// # Errors
///
/// [`LmsrError::InsufficientShares`] if `shares` exceeds that side's supply,
/// plus the usual domain errors.
pub fn sell_return(q_yes: u64, q_no: u64, b: u64, outcome: Outcome, shares: u64) -> Result<u64> {
    check_state(q_yes, q_no, b)?;
    if shares > outcome.select(q_yes, q_no) {
        return Err(LmsrError::InsufficientShares);
    }
    if shares == 0 {
        return Ok(0);
    }
    let (n_yes, n_no) = apply(q_yes, q_no, outcome, shares, false)?;
    // C(old) − C(new).
    let d = delta_cost(n_yes, n_no, q_yes, q_no, b)?;
    if d.is_negative() {
        return Ok(0);
    }
    Ok(d.to_base_units_floor()?)
}

/// Shares of `outcome` obtainable for spending `collateral`, rounded **down**
/// (floor).
///
/// This is the inverse a `buy_shares` instruction actually needs, since users
/// spend USDC rather than naming a share count. It is **closed form**, not
/// bisected — there is no iteration over trial trades and no iteration cap.
///
/// # Not clamped to `MAX_Q`
///
/// The returned count is the pure mathematical answer. At extreme skew a tiny
/// spend legitimately buys more than [`MAX_Q`](crate::bounds::MAX_Q) shares of the near-worthless
/// side; rejecting that is the *program's* job, not the core's. Callers must
/// check `q_out + result <= MAX_Q` themselves.
///
/// # Derivation
///
/// Solving `C(q_out + d, q_other) − C(q_out, q_other) = X` for `d`, then
/// substituting the stabilised `C` and pulling the unbounded `e^(X/b)` out of
/// the logarithm, gives (`m = max(q_yes, q_no)`, `u_i = exp((q_i − m)/b)`):
///
/// ```text
/// d = (m − q_out) + X + b·ln( u_out + u_other·(1 − e^(−X/b)) )
/// ```
///
/// That form is exact but not *evaluable* in Q64.64: the log's argument falls
/// far below `1` at deep skew or for a small spend, and `b·ln(z)` amplifies the
/// absolute error of a tiny `z` by `b/z`. So the argument is instead split in
/// the log domain. With `w = 1 − e^(−X/b)`,
///
/// ```text
/// a = ln(u_out)         = (q_out   − m)/b          →  b·a = q_out − m      exactly
/// c = ln(u_other·w)     = (q_other − m)/b + ln(w)  →  b·c = q_other − m + b·ln(w)
///
/// b·ln(e^a + e^c) = b·max(a, c) + b·ln(1 + e^(−|a − c|))
/// ```
///
/// The residual logarithm now always has an argument in `[1, 2]`. Substituting
/// and letting the exact integers cancel:
///
/// ```text
/// a ≥ c :  d = X + b·ln(1 + e^(−(a−c)))
/// a < c :  d = X + (q_other − q_out) + b·ln(w) + b·ln(1 + e^(−(c−a)))
/// ```
///
/// Note that `(m − q_out)` cancels analytically in both branches, so no
/// `~1e15`-magnitude subtraction survives. `b·ln(w)` is itself computed as
/// `b·(ln X − ln b) + b·ln((1 − e^(−t))/t)` for small `t = X/b`, because `t` as
/// a `Fixed` has only `~5.4e-8` relative precision at `t = 1e-12` while `ln X`
/// and `ln b` are taken of exact integers.
///
/// # Errors
///
/// The usual domain errors; [`LmsrError::Overflow`] for a `collateral` so large
/// that the answer leaves Q64.64 (`≥ 2^63` base units).
pub fn shares_for_cost(
    q_yes: u64,
    q_no: u64,
    b: u64,
    outcome: Outcome,
    collateral: u64,
) -> Result<u64> {
    check_state(q_yes, q_no, b)?;
    if collateral == 0 {
        return Ok(0);
    }
    let q_out = outcome.select(q_yes, q_no);
    let q_other = outcome.other().select(q_yes, q_no);
    let m = if q_yes >= q_no { q_yes } else { q_no };
    let b_fixed = units(b)?;

    // First try the direct form. Its log argument `u_out + u_other·w` is often
    // well conditioned — always so when the bought side is the majority one —
    // and it then reproduces the structural cancellations the oracle sees
    // (e.g. `m − q_out == X` makes the argument exactly `1`), which the
    // log-domain rewrite below rounds away.
    let t = Fixed::from_ratio(i128::from(collateral), i128::from(b))?;
    let w = t
        .checked_neg()
        .ok_or(LmsrError::Overflow)?
        .expm1()?
        .checked_neg()
        .ok_or(LmsrError::Overflow)?;
    let u_out = exp_ratio(i128::from(q_out) - i128::from(m), b)?;
    let u_other = exp_ratio(i128::from(q_other) - i128::from(m), b)?;
    let arg = add(u_out, mul(u_other, w)?)?;
    if arg >= NATURAL_MIN {
        let head = i128::from(m) - i128::from(q_out);
        let head = i64::try_from(head).map_err(|_| LmsrError::Overflow)?;
        let d = add(
            add(Fixed::from_int(head), units(collateral)?)?,
            mul(b_fixed, arg.ln()?)?,
        )?;
        return if d.is_negative() {
            Ok(0)
        } else {
            Ok(d.to_base_units_floor()?)
        };
    }

    // ln(w) = ln(1 − e^(−X/b)) ≤ 0.
    let ln_w = ln_one_minus_exp_neg(collateral, b)?;

    // a − c = (q_out − q_other)/b − ln(w).
    let gap_ratio = Fixed::from_ratio(i128::from(q_out) - i128::from(q_other), i128::from(b))?;
    let delta_exp = sub(gap_ratio, ln_w)?;

    // b·ln(1 + e^(−|a − c|)) ∈ [0, b·ln 2].
    let e_arg = delta_exp
        .checked_abs()
        .ok_or(LmsrError::Overflow)?
        .checked_neg()
        .ok_or(LmsrError::Overflow)?;
    let tail_ln = add(Fixed::ONE, e_arg.exp()?)?.ln()?;
    let tail = mul(b_fixed, tail_ln)?;

    let x = units(collateral)?;
    let d = if delta_exp.is_negative() {
        // a < c, which forces q_out ≤ q_other (ln w ≤ 0), so the gap is ≥ 0.
        let gap = i128::from(q_other) - i128::from(q_out);
        let gap = i64::try_from(gap).map_err(|_| LmsrError::Overflow)?;
        let b_ln_w = mul(b_fixed, ln_w)?;
        add(add(add(x, Fixed::from_int(gap))?, b_ln_w)?, tail)?
    } else {
        add(x, tail)?
    };

    if d.is_negative() {
        return Ok(0);
    }
    Ok(d.to_base_units_floor()?)
}

/// The market maker's worst-case subsidy, `b · ln 2`, rounded **up** (ceil).
///
/// This is the plan §1.4 max-loss bound. `cost(0, 0, b)` equals it (up to the
/// rounding direction) and no reachable state can cost the maker more.
///
/// # Errors
///
/// [`LmsrError::BOutOfRange`] outside the frozen `b` range.
pub fn max_loss_bound(b: u64) -> Result<u64> {
    validate_b(b)?;
    let v = mul(units(b)?, Fixed::LN_2)?;
    Ok(v.to_base_units_ceil()?)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

#[inline]
fn check_state(q_yes: u64, q_no: u64, b: u64) -> Result<()> {
    validate_q(q_yes)?;
    validate_q(q_no)?;
    validate_b(b)
}

#[inline]
fn units(n: u64) -> Result<Fixed> {
    Ok(Fixed::from_base_units(n)?)
}

#[inline]
fn add(a: Fixed, b: Fixed) -> Result<Fixed> {
    a.checked_add(b).ok_or(LmsrError::Overflow)
}

#[inline]
fn sub(a: Fixed, b: Fixed) -> Result<Fixed> {
    a.checked_sub(b).ok_or(LmsrError::Overflow)
}

/// Round-to-nearest multiply. Nearest, not truncating, so the per-step bias
/// does not accumulate through the `b · ln(·)` chain.
#[inline]
fn mul(a: Fixed, b: Fixed) -> Result<Fixed> {
    a.checked_mul_nearest(b).ok_or(LmsrError::Overflow)
}

/// `(m, x)` with `m = max(q_yes, q_no)` an exact integer and
/// `x = (min − max)/b ≤ 0`, so that `S = u_yes + u_no = 1 + e^x ∈ [1, 2]`.
///
/// Carrying the *exponent* rather than the minority term itself is what lets
/// [`b_small_softplus`] keep working after `e^x` has underflowed to zero.
fn skew_terms(q_yes: u64, q_no: u64, b: u64) -> Result<(u64, Fixed)> {
    let (m, lo) = if q_yes >= q_no {
        (q_yes, q_no)
    } else {
        (q_no, q_yes)
    };
    let x = Fixed::from_ratio(i128::from(lo) - i128::from(m), i128::from(b))?;
    Ok((m, x))
}

/// `exp(num / b)`. Callers always pass `num ≤ 0`, so the result is in `(0, 1]`
/// and underflow to exactly zero at deep skew is the correct answer.
#[inline]
fn exp_ratio(num: i128, b: u64) -> Result<Fixed> {
    let r = Fixed::from_ratio(num, i128::from(b))?;
    Ok(r.exp()?)
}

/// `b · ln(1 + e^x)` — the "softplus" term that both `C` and every trade
/// difference are built from. `x ≤ 0`.
///
/// For `x > -20` this is the plain stabilised form: `S = 1 + e^x ∈ [1, 2]`, so
/// `b · ln(S)` carries only `≈ b · 2^-64 < 1e-7` base units of error.
///
/// Below that the minority term is small enough that `ln(1 + u) = u − u²/2 + …`
/// converges immediately, and the leading term is evaluated as
/// `b·u = exp(ln b + x)` — which is still a well-scaled `Fixed` long after
/// `u = e^x` itself has underflowed to zero. That extends the usable skew from
/// `|Δq|/b ≈ 45` to `≈ 45 + ln b`, i.e. up to ~72 at `B_MAX`.
fn b_softplus(b_fixed: Fixed, x: Fixed) -> Result<Fixed> {
    if x > TINY_X {
        let s = add(Fixed::ONE, x.exp()?)?;
        return mul(b_fixed, s.ln()?);
    }
    b_small_softplus(b_fixed.ln()?, x)
}

/// `b · ln(1 + e^x)` for `x ≤ TINY_X`, given `ln b`. Returns exactly zero once
/// even `b·e^x` is below half an ulp, which is the correct limit.
///
/// `ln(1+u) = u − u²/2 + O(u³)` with `u ≤ e^-20`, so two terms are exact to
/// under `1e-26·b`. Each is evaluated pre-scaled: `b·u^k/k = exp(ln b + k·x)/k`.
fn b_small_softplus(ln_b: Fixed, x: Fixed) -> Result<Fixed> {
    // `ln b + x ≤ ln(B_MAX) − 20 < 8`, so this `exp` cannot overflow.
    let bu = add(ln_b, x)?.exp()?;
    if bu.is_zero() {
        return Ok(Fixed::ZERO);
    }
    sub(bu, b_scaled_pow(ln_b, x, 2)?)
}

/// `b · e^(k·x) / k`, i.e. the `k`-th term of `b·ln(1 + e^x)`.
fn b_scaled_pow(ln_b: Fixed, x: Fixed, k: u32) -> Result<Fixed> {
    let kx = mul(Fixed::from_int(i64::from(k)), x)?;
    let v = add(ln_b, kx)?.exp()?;
    div_int_nearest(v, k)
}

/// `C(q_yes, q_no)` as an unrounded Q64.64 value.
fn cost_fixed(q_yes: u64, q_no: u64, b: u64) -> Result<Fixed> {
    check_state(q_yes, q_no, b)?;
    let (m, x) = skew_terms(q_yes, q_no, b)?;
    add(units(m)?, b_softplus(units(b)?, x)?)
}

/// `C(q_yes1, q_no1) − C(q_yes0, q_no0)`, cancellation-free.
///
/// `(m1 − m0)` is an exact integer and `S1 / S0` is a ratio of two values in
/// `[1, 2]`, so nothing of magnitude `~1e15` is ever subtracted.
///
/// When *both* states are deeply skewed the ratio collapses to `1` and all the
/// information is lost, so that case takes the difference of two
/// [`b_small_softplus`] values instead — both tiny, so there is nothing to
/// cancel there either.
fn delta_cost(q_yes0: u64, q_no0: u64, q_yes1: u64, q_no1: u64, b: u64) -> Result<Fixed> {
    let (m0, x0) = skew_terms(q_yes0, q_no0, b)?;
    let (m1, x1) = skew_terms(q_yes1, q_no1, b)?;
    let b_fixed = units(b)?;

    let tail = if x0 <= TINY_X && x1 <= TINY_X {
        let ln_b = b_fixed.ln()?;
        sub(b_small_softplus(ln_b, x1)?, b_small_softplus(ln_b, x0)?)?
    } else {
        let s0 = add(Fixed::ONE, x0.exp()?)?;
        let s1 = add(Fixed::ONE, x1.exp()?)?;
        let ratio = s1.checked_div(s0).ok_or(LmsrError::DivByZero)?;
        mul(b_fixed, ratio.ln()?)?
    };

    let dm = i128::from(m1) - i128::from(m0);
    let dm = i64::try_from(dm).map_err(|_| LmsrError::Overflow)?;
    add(Fixed::from_int(dm), tail)
}

/// Apply `±shares` to the chosen side, checked.
fn apply(q_yes: u64, q_no: u64, outcome: Outcome, shares: u64, buy: bool) -> Result<(u64, u64)> {
    let step = |q: u64| -> Result<u64> {
        if buy {
            q.checked_add(shares).ok_or(LmsrError::Overflow)
        } else {
            q.checked_sub(shares).ok_or(LmsrError::InsufficientShares)
        }
    };
    match outcome {
        Outcome::Yes => Ok((step(q_yes)?, q_no)),
        Outcome::No => Ok((q_yes, step(q_no)?)),
    }
}

/// `ln(1 − e^(−x/b))` for `x ≥ 1`, `b ≥ B_MIN`. Always `≤ 0`.
///
/// For `t = x/b ≥ 1/2` the value `w = −expm1(−t) ≥ 0.39` carries full relative
/// precision and `ln(w)` is taken directly.
///
/// For `t < 1/2`, `w ≈ t` and `t` is a *small* `Fixed`: at `t = 1e-12` its
/// relative precision is only `~5.4e-8`, and `b·ln` would amplify that to
/// `~1e5` base units. So the split
///
/// ```text
/// ln(1 − e^(−t)) = ln(t) + ln(g(t)),   g(t) = (1 − e^(−t)) / t ∈ [0.787, 1]
/// ```
///
/// is used instead: `ln(t)` is recovered as `ln(x) − ln(b)` from the *exact*
/// integers (both `≥ 1.0`, so both logs are well conditioned), and `g` is near
/// `1`, so its own absolute precision is all that is needed.
fn ln_one_minus_exp_neg(x: u64, b: u64) -> Result<Fixed> {
    let t = Fixed::from_ratio(i128::from(x), i128::from(b))?;
    if t >= HALF {
        let w = t
            .checked_neg()
            .ok_or(LmsrError::Overflow)?
            .expm1()?
            .checked_neg()
            .ok_or(LmsrError::Overflow)?;
        return Ok(w.ln()?);
    }
    let ln_t = sub(units(x)?.ln()?, units(b)?.ln()?)?;
    let g = g_series(t)?;
    add(ln_t, g.ln()?)
}

/// `g(t) = (1 − e^(−t)) / t = Σ_{k≥0} (−t)^k / (k+1)!`, for `t ∈ [0, 1/2)`.
///
/// Summed directly rather than as a quotient: the quotient would divide a value
/// carrying `~3 ulp` of *absolute* error by a `t` as small as `1e-12`, blowing
/// that up to `1.6e-7`. The series keeps `g` accurate to a few ulp because
/// every term is small and the leading term is exactly `1`.
fn g_series(t: Fixed) -> Result<Fixed> {
    let mut term = Fixed::ONE;
    let mut sum = Fixed::ONE;
    let mut k: u32 = 1;
    while k <= G_MAX_TERMS {
        term = div_int_nearest(mul(term, t)?, k + 1)?;
        if term.is_zero() {
            break;
        }
        sum = if k % 2 == 1 {
            sub(sum, term)?
        } else {
            add(sum, term)?
        };
        k += 1;
    }
    Ok(sum)
}

/// `v / n` for a small positive integer `n`, rounded to nearest (ties away from
/// zero). `fixed.rs` keeps its own copy of this private, hence the duplicate.
fn div_int_nearest(v: Fixed, n: u32) -> Result<Fixed> {
    if n == 0 {
        return Err(LmsrError::DivByZero);
    }
    let raw = v.to_raw();
    let d = u128::from(n);
    let mag = raw
        .unsigned_abs()
        .checked_add(d / 2)
        .ok_or(LmsrError::Overflow)?
        / d;
    if mag > i128::MAX as u128 {
        return Err(LmsrError::Overflow);
    }
    let signed = mag as i128;
    Ok(Fixed::from_raw(if raw < 0 { -signed } else { signed }))
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod vectors {
    //! A spot-check sample of T01's committed golden vectors
    //! (`reference/vectors/*.json`), transcribed verbatim.
    //!
    //! This is deliberately *not* the conformance suite — that is T04's job and
    //! lives in `crates/lmsr/tests/`. What is here is the subset that would
    //! catch a structural mistake: the deep-skew and `exceeds_max_q`
    //! `shares_for_cost` cases, the `MAX_Q`/`B_MIN`/`B_MAX` corners, the
    //! market-open state, every 1-base-unit trade in `edge.json`, and a
    //! deterministic stride through `grid.json`.


    /// `(id, b, q_yes, q_no, cost, price_yes)`
    pub const STATES: &[(&str, u64, u64, u64, u64, u64)] = &[
        ("edge-00001", 10000000, 0, 0, 6931471, 500000),
        ("edge-00006", 12345678, 0, 0, 8557371, 500000),
        ("edge-00011", 100000000, 0, 0, 69314718, 500000),
        ("edge-00016", 1000000000, 0, 0, 693147180, 500000),
        ("edge-00021", 10000000000, 0, 0, 6931471805, 500000),
        ("edge-00026", 100000000000, 0, 0, 69314718055, 500000),
        ("edge-00031", 999999999999, 0, 0, 693147180559, 500000),
        ("edge-00036", 1000000000000, 0, 0, 693147180559, 500000),
        ("edge-00042", 10000000, 0, 1, 6931472, 499999),
        ("edge-00043", 10000000, 0, 1000000, 7443966, 475020),
        ("edge-00044", 10000000, 0, 500000000000000, 500000000000000, 0),
        ("edge-00045", 10000000, 0, 999999999999999, 999999999999999, 0),
        ("edge-00046", 10000000, 0, 1000000000000000, 1000000000000000, 0),
        ("edge-00047", 10000000, 1, 0, 6931472, 500000),
        ("edge-00048", 10000000, 1, 1, 6931472, 500000),
        ("edge-00049", 10000000, 1, 1000000, 7443967, 475020),
        ("edge-00050", 10000000, 1, 500000000000000, 500000000000000, 0),
        ("edge-00051", 10000000, 1, 999999999999999, 999999999999999, 0),
        ("edge-00052", 10000000, 1, 1000000000000000, 1000000000000000, 0),
        ("edge-00053", 10000000, 1000000, 0, 7443966, 524979),
        ("edge-00054", 10000000, 1000000, 1, 7443967, 524979),
        ("edge-00055", 10000000, 1000000, 1000000, 7931471, 500000),
        ("edge-00056", 10000000, 1000000, 500000000000000, 500000000000000, 0),
        ("edge-00057", 10000000, 1000000, 999999999999999, 999999999999999, 0),
        ("edge-00058", 10000000, 1000000, 1000000000000000, 1000000000000000, 0),
        ("edge-00059", 10000000, 500000000000000, 0, 500000000000000, 1000000),
        ("edge-00060", 10000000, 500000000000000, 1, 500000000000000, 1000000),
        ("edge-00061", 10000000, 500000000000000, 1000000, 500000000000000, 1000000),
        ("edge-00062", 10000000, 500000000000000, 500000000000000, 500000006931471, 500000),
        ("edge-00063", 10000000, 500000000000000, 999999999999999, 999999999999999, 0),
        ("edge-00064", 10000000, 500000000000000, 1000000000000000, 1000000000000000, 0),
        ("edge-00065", 10000000, 999999999999999, 0, 999999999999999, 1000000),
        ("edge-00066", 10000000, 999999999999999, 1, 999999999999999, 1000000),
        ("edge-00067", 10000000, 999999999999999, 1000000, 999999999999999, 1000000),
        ("edge-00068", 10000000, 999999999999999, 500000000000000, 999999999999999, 1000000),
        ("edge-00069", 10000000, 999999999999999, 999999999999999, 1000000006931470, 500000),
        ("edge-00070", 10000000, 999999999999999, 1000000000000000, 1000000006931471, 499999),
        ("edge-00071", 10000000, 1000000000000000, 0, 1000000000000000, 1000000),
        ("edge-00072", 10000000, 1000000000000000, 1, 1000000000000000, 1000000),
        ("edge-00073", 10000000, 1000000000000000, 1000000, 1000000000000000, 1000000),
        ("edge-00074", 10000000, 1000000000000000, 500000000000000, 1000000000000000, 1000000),
        ("edge-00075", 10000000, 1000000000000000, 999999999999999, 1000000006931471, 500000),
        ("edge-00076", 10000000, 1000000000000000, 1000000000000000, 1000000006931471, 500000),
        ("edge-00078", 1000000000000, 0, 1, 693147180560, 499999),
        ("edge-00079", 1000000000000, 0, 1000000, 693147680560, 499999),
        ("edge-00080", 1000000000000, 0, 500000000000000, 500000000000000, 0),
        ("edge-00081", 1000000000000, 0, 999999999999999, 999999999999999, 0),
        ("edge-00082", 1000000000000, 0, 1000000000000000, 1000000000000000, 0),
        ("edge-00083", 1000000000000, 1, 0, 693147180560, 500000),
        ("edge-00084", 1000000000000, 1, 1, 693147180560, 500000),
        ("edge-00085", 1000000000000, 1, 1000000, 693147680560, 499999),
        ("edge-00086", 1000000000000, 1, 500000000000000, 500000000000000, 0),
        ("edge-00087", 1000000000000, 1, 999999999999999, 999999999999999, 0),
        ("edge-00088", 1000000000000, 1, 1000000000000000, 1000000000000000, 0),
        ("edge-00089", 1000000000000, 1000000, 0, 693147680560, 500000),
        ("edge-00090", 1000000000000, 1000000, 1, 693147680560, 500000),
        ("edge-00091", 1000000000000, 1000000, 1000000, 693148180559, 500000),
        ("edge-00092", 1000000000000, 1000000, 500000000000000, 500000000000000, 0),
        ("edge-00093", 1000000000000, 1000000, 999999999999999, 999999999999999, 0),
        ("edge-00094", 1000000000000, 1000000, 1000000000000000, 1000000000000000, 0),
        ("edge-00095", 1000000000000, 500000000000000, 0, 500000000000000, 1000000),
        ("edge-00096", 1000000000000, 500000000000000, 1, 500000000000000, 1000000),
        ("edge-00097", 1000000000000, 500000000000000, 1000000, 500000000000000, 1000000),
        ("edge-00098", 1000000000000, 500000000000000, 500000000000000, 500693147180559, 500000),
        ("edge-00099", 1000000000000, 500000000000000, 999999999999999, 999999999999999, 0),
        ("edge-00100", 1000000000000, 500000000000000, 1000000000000000, 1000000000000000, 0),
        ("edge-00101", 1000000000000, 999999999999999, 0, 999999999999999, 1000000),
        ("edge-00102", 1000000000000, 999999999999999, 1, 999999999999999, 1000000),
        ("edge-00103", 1000000000000, 999999999999999, 1000000, 999999999999999, 1000000),
        ("edge-00104", 1000000000000, 999999999999999, 500000000000000, 999999999999999, 1000000),
        ("edge-00105", 1000000000000, 999999999999999, 999999999999999, 1000693147180558, 500000),
        ("edge-00106", 1000000000000, 999999999999999, 1000000000000000, 1000693147180559, 499999),
        ("edge-00107", 1000000000000, 1000000000000000, 0, 1000000000000000, 1000000),
        ("edge-00108", 1000000000000, 1000000000000000, 1, 1000000000000000, 1000000),
        ("edge-00109", 1000000000000, 1000000000000000, 1000000, 1000000000000000, 1000000),
        ("edge-00110", 1000000000000, 1000000000000000, 500000000000000, 1000000000000000, 1000000),
        ("edge-00111", 1000000000000, 1000000000000000, 999999999999999, 1000693147180559, 500000),
        ("edge-00112", 1000000000000, 1000000000000000, 1000000000000000, 1000693147180559, 500000),
        ("edge-00127", 12345678, 1000000000000000, 0, 1000000000000000, 1000000),
        ("edge-00134", 12345678, 0, 1000000000000000, 1000000000000000, 0),
        ("edge-00141", 100000000, 1000000000000000, 0, 1000000000000000, 1000000),
        ("edge-00148", 100000000, 0, 1000000000000000, 1000000000000000, 0),
        ("edge-00155", 1000000000, 1000000000000000, 0, 1000000000000000, 1000000),
        ("edge-00162", 1000000000, 0, 1000000000000000, 1000000000000000, 0),
        ("edge-00169", 10000000000, 1000000000000000, 0, 1000000000000000, 1000000),
        ("edge-00176", 10000000000, 0, 1000000000000000, 1000000000000000, 0),
        ("edge-00183", 100000000000, 1000000000000000, 0, 1000000000000000, 1000000),
        ("edge-00190", 100000000000, 0, 1000000000000000, 1000000000000000, 0),
        ("edge-00197", 999999999999, 1000000000000000, 0, 1000000000000000, 1000000),
        ("edge-00204", 999999999999, 0, 1000000000000000, 1000000000000000, 0),
        ("edge-00225", 10000000, 50000000, 0, 50067153, 993307),
        ("edge-00226", 10000000, 0, 50000000, 50067153, 6692),
        ("edge-00232", 10000000, 500000000, 0, 500000000, 999999),
        ("edge-00233", 10000000, 0, 500000000, 500000000, 0),
        ("edge-00239", 10000000, 5000000000, 0, 5000000000, 1000000),
        ("edge-00240", 10000000, 0, 5000000000, 5000000000, 0),
        ("edge-00246", 10000000, 50000000000, 0, 50000000000, 1000000),
        ("edge-00247", 10000000, 0, 50000000000, 50000000000, 0),
        ("edge-00253", 10000000, 500000000000, 0, 500000000000, 1000000),
        ("edge-00254", 10000000, 0, 500000000000, 500000000000, 0),
        ("edge-00260", 10000000, 10000000000000, 0, 10000000000000, 1000000),
        ("edge-00261", 10000000, 0, 10000000000000, 10000000000000, 0),
        ("edge-00267", 10000000, 100000000000000, 0, 100000000000000, 1000000),
        ("edge-00268", 10000000, 0, 100000000000000, 100000000000000, 0),
        ("edge-00280", 100000000, 500000000, 0, 500671534, 993307),
        ("edge-00281", 100000000, 0, 500000000, 500671534, 6692),
        ("edge-00287", 100000000, 5000000000, 0, 5000000000, 999999),
        ("edge-00288", 100000000, 0, 5000000000, 5000000000, 0),
        ("edge-00294", 100000000, 50000000000, 0, 50000000000, 1000000),
        ("edge-00295", 100000000, 0, 50000000000, 50000000000, 0),
        ("edge-00301", 100000000, 500000000000, 0, 500000000000, 1000000),
        ("edge-00302", 100000000, 0, 500000000000, 500000000000, 0),
        ("edge-00308", 100000000, 5000000000000, 0, 5000000000000, 1000000),
        ("edge-00309", 100000000, 0, 5000000000000, 5000000000000, 0),
        ("edge-00315", 100000000, 100000000000000, 0, 100000000000000, 1000000),
        ("edge-00316", 100000000, 0, 100000000000000, 100000000000000, 0),
        ("edge-00328", 1000000000, 5000000000, 0, 5006715348, 993307),
        ("edge-00329", 1000000000, 0, 5000000000, 5006715348, 6692),
        ("edge-00335", 1000000000, 50000000000, 0, 50000000000, 999999),
        ("edge-00336", 1000000000, 0, 50000000000, 50000000000, 0),
        ("edge-00342", 1000000000, 500000000000, 0, 500000000000, 1000000),
        ("edge-00343", 1000000000, 0, 500000000000, 500000000000, 0),
        ("edge-00349", 1000000000, 5000000000000, 0, 5000000000000, 1000000),
        ("edge-00350", 1000000000, 0, 5000000000000, 5000000000000, 0),
        ("edge-00356", 1000000000, 50000000000000, 0, 50000000000000, 1000000),
        ("edge-00357", 1000000000, 0, 50000000000000, 50000000000000, 0),
        ("edge-00369", 10000000000, 50000000000, 0, 50067153484, 993307),
        ("edge-00370", 10000000000, 0, 50000000000, 50067153484, 6692),
        ("edge-00376", 10000000000, 500000000000, 0, 500000000000, 999999),
        ("edge-00377", 10000000000, 0, 500000000000, 500000000000, 0),
        ("edge-00383", 10000000000, 5000000000000, 0, 5000000000000, 1000000),
        ("edge-00384", 10000000000, 0, 5000000000000, 5000000000000, 0),
        ("edge-00390", 10000000000, 50000000000000, 0, 50000000000000, 1000000),
        ("edge-00391", 10000000000, 0, 50000000000000, 50000000000000, 0),
        ("edge-00397", 10000000000, 500000000000000, 0, 500000000000000, 1000000),
        ("edge-00398", 10000000000, 0, 500000000000000, 500000000000000, 0),
        ("edge-00404", 100000000000, 500000000000, 0, 500671534848, 993307),
        ("edge-00405", 100000000000, 0, 500000000000, 500671534848, 6692),
        ("edge-00411", 100000000000, 5000000000000, 0, 5000000000000, 999999),
        ("edge-00412", 100000000000, 0, 5000000000000, 5000000000000, 0),
        ("edge-00418", 100000000000, 50000000000000, 0, 50000000000000, 1000000),
        ("edge-00419", 100000000000, 0, 50000000000000, 50000000000000, 0),
        ("edge-00425", 100000000000, 500000000000000, 0, 500000000000000, 1000000),
        ("edge-00426", 100000000000, 0, 500000000000000, 500000000000000, 0),
        ("edge-00432", 1000000000000, 5000000000000, 0, 5006715348489, 993307),
        ("edge-00433", 1000000000000, 0, 5000000000000, 5006715348489, 6692),
        ("edge-00439", 1000000000000, 50000000000000, 0, 50000000000000, 999999),
        ("edge-00440", 1000000000000, 0, 50000000000000, 50000000000000, 0),
        ("grid-00389", 10000000, 600000000, 10000000, 600000000, 999999),
        ("grid-01844", 100000000000, 25000000000, 300000000000, 306196758900, 60086),
    ];

    /// `(id, b, q_yes, q_no, is_yes, shares, collateral_in)`
    pub const BUYS: &[(&str, u64, u64, u64, bool, u64, u64)] = &[
        ("edge-00002", 10000000, 0, 0, true, 1, 1),
        ("edge-00032", 999999999999, 0, 0, true, 1, 1),
        ("edge-00142", 100000000, 1000000000000000, 0, false, 1, 0),
        ("edge-00184", 100000000000, 1000000000000000, 0, false, 1, 0),
        ("edge-00227", 10000000, 50000000, 0, true, 10000000, 9957604),
        ("edge-00269", 10000000, 100000000000000, 0, true, 10000000, 10000000),
        ("edge-00311", 100000000, 5000000000000, 0, false, 100000000, 0),
        ("edge-00358", 1000000000, 50000000000000, 0, true, 1000000000, 1000000000),
        ("edge-00400", 10000000000, 500000000000000, 0, false, 10000000000, 0),
        ("edge-00442", 1000000000000, 50000000000000, 0, false, 1000000000000, 1),
        ("edge-00476", 10000000, 10000000, 0, false, 1, 1),
        ("edge-00506", 100000000, 100000000, 0, false, 1, 1),
        ("edge-00536", 1000000000, 1000000000, 0, false, 1, 1),
        ("edge-00566", 10000000000, 10000000000, 0, false, 1, 1),
        ("edge-00596", 100000000000, 100000000000, 0, false, 1, 1),
        ("edge-00626", 1000000000000, 1000000000000, 0, false, 1, 1),
        ("edge-00657", 100000000, 999999999000000, 1000000000000000, true, 1000000, 498751),
        ("edge-00699", 10000000000, 999999999000000, 1000000000000000, true, 1000000, 499988),
        ("edge-00741", 1000000000000, 999999999000000, 1000000000000000, true, 1000000, 500000),
        ("edge-00003", 10000000, 0, 0, false, 1, 1),
        ("edge-00007", 12345678, 0, 0, true, 1, 1),
        ("edge-00008", 12345678, 0, 0, false, 1, 1),
        ("edge-00012", 100000000, 0, 0, true, 1, 1),
        ("edge-00013", 100000000, 0, 0, false, 1, 1),
        ("edge-00017", 1000000000, 0, 0, true, 1, 1),
        ("edge-00018", 1000000000, 0, 0, false, 1, 1),
        ("edge-00022", 10000000000, 0, 0, true, 1, 1),
        ("edge-00023", 10000000000, 0, 0, false, 1, 1),
        ("edge-00027", 100000000000, 0, 0, true, 1, 1),
        ("edge-00028", 100000000000, 0, 0, false, 1, 1),
        ("edge-00033", 999999999999, 0, 0, false, 1, 1),
        ("edge-00037", 1000000000000, 0, 0, true, 1, 1),
        ("edge-00038", 1000000000000, 0, 0, false, 1, 1),
        ("edge-00114", 10000000, 1000000000000000, 0, false, 1, 0),
        ("edge-00121", 10000000, 0, 1000000000000000, true, 1, 0),
        ("edge-00128", 12345678, 1000000000000000, 0, false, 1, 0),
        ("edge-00135", 12345678, 0, 1000000000000000, true, 1, 0),
        ("edge-00149", 100000000, 0, 1000000000000000, true, 1, 0),
        ("edge-00156", 1000000000, 1000000000000000, 0, false, 1, 0),
        ("edge-00163", 1000000000, 0, 1000000000000000, true, 1, 0),
        ("edge-00170", 10000000000, 1000000000000000, 0, false, 1, 0),
        ("edge-00177", 10000000000, 0, 1000000000000000, true, 1, 0),
        ("edge-00191", 100000000000, 0, 1000000000000000, true, 1, 0),
        ("edge-00198", 999999999999, 1000000000000000, 0, false, 1, 0),
        ("edge-00205", 999999999999, 0, 1000000000000000, true, 1, 0),
        ("edge-00212", 1000000000000, 1000000000000000, 0, false, 1, 0),
        ("edge-00219", 1000000000000, 0, 1000000000000000, true, 1, 0),
        ("edge-00457", 10000000, 1, 0, true, 1, 1),
        ("edge-00460", 10000000, 1, 0, false, 1, 1),
        ("edge-00462", 10000000, 0, 1, true, 1, 1),
        ("edge-00464", 10000000, 0, 1, false, 1, 1),
        ("edge-00467", 10000000, 10000000, 10000000, true, 1, 1),
        ("edge-00470", 10000000, 10000000, 10000000, false, 1, 1),
        ("edge-00473", 10000000, 10000000, 0, true, 1, 1),
        ("edge-00478", 10000000, 999999999999999, 0, true, 1, 1),
        ("edge-00481", 10000000, 999999999999999, 0, false, 1, 0),
        ("edge-00487", 100000000, 1, 0, true, 1, 1),
        ("edge-00490", 100000000, 1, 0, false, 1, 1),
        ("edge-00492", 100000000, 0, 1, true, 1, 1),
        ("edge-00494", 100000000, 0, 1, false, 1, 1),
        ("edge-00497", 100000000, 100000000, 100000000, true, 1, 1),
        ("edge-00500", 100000000, 100000000, 100000000, false, 1, 1),
        ("edge-00503", 100000000, 100000000, 0, true, 1, 1),
        ("edge-00508", 100000000, 999999999999999, 0, true, 1, 1),
        ("edge-00511", 100000000, 999999999999999, 0, false, 1, 0),
        ("edge-00517", 1000000000, 1, 0, true, 1, 1),
        ("edge-00520", 1000000000, 1, 0, false, 1, 1),
        ("edge-00522", 1000000000, 0, 1, true, 1, 1),
        ("edge-00524", 1000000000, 0, 1, false, 1, 1),
        ("edge-00527", 1000000000, 1000000000, 1000000000, true, 1, 1),
        ("edge-00530", 1000000000, 1000000000, 1000000000, false, 1, 1),
        ("edge-00533", 1000000000, 1000000000, 0, true, 1, 1),
        ("edge-00538", 1000000000, 999999999999999, 0, true, 1, 1),
        ("edge-00541", 1000000000, 999999999999999, 0, false, 1, 0),
        ("edge-00547", 10000000000, 1, 0, true, 1, 1),
        ("edge-00550", 10000000000, 1, 0, false, 1, 1),
        ("edge-00552", 10000000000, 0, 1, true, 1, 1),
        ("edge-00554", 10000000000, 0, 1, false, 1, 1),
        ("edge-00557", 10000000000, 10000000000, 10000000000, true, 1, 1),
        ("edge-00560", 10000000000, 10000000000, 10000000000, false, 1, 1),
        ("edge-00563", 10000000000, 10000000000, 0, true, 1, 1),
        ("edge-00568", 10000000000, 999999999999999, 0, true, 1, 1),
        ("edge-00571", 10000000000, 999999999999999, 0, false, 1, 0),
        ("edge-00577", 100000000000, 1, 0, true, 1, 1),
        ("edge-00580", 100000000000, 1, 0, false, 1, 1),
        ("edge-00582", 100000000000, 0, 1, true, 1, 1),
        ("edge-00584", 100000000000, 0, 1, false, 1, 1),
        ("edge-00587", 100000000000, 100000000000, 100000000000, true, 1, 1),
        ("edge-00590", 100000000000, 100000000000, 100000000000, false, 1, 1),
        ("edge-00593", 100000000000, 100000000000, 0, true, 1, 1),
        ("edge-00598", 100000000000, 999999999999999, 0, true, 1, 1),
        ("edge-00601", 100000000000, 999999999999999, 0, false, 1, 0),
        ("edge-00607", 1000000000000, 1, 0, true, 1, 1),
        ("edge-00610", 1000000000000, 1, 0, false, 1, 1),
        ("edge-00612", 1000000000000, 0, 1, true, 1, 1),
        ("edge-00614", 1000000000000, 0, 1, false, 1, 1),
        ("edge-00617", 1000000000000, 1000000000000, 1000000000000, true, 1, 1),
        ("edge-00620", 1000000000000, 1000000000000, 1000000000000, false, 1, 1),
        ("edge-00623", 1000000000000, 1000000000000, 0, true, 1, 1),
        ("edge-00628", 1000000000000, 999999999999999, 0, true, 1, 1),
        ("edge-00631", 1000000000000, 999999999999999, 0, false, 1, 0),
        ("edge-00634", 10000000, 999999999999999, 1000000000000000, true, 1, 1),
        ("edge-00655", 100000000, 999999999999999, 1000000000000000, true, 1, 1),
        ("edge-00676", 1000000000, 999999999999999, 1000000000000000, true, 1, 1),
        ("edge-00697", 10000000000, 999999999999999, 1000000000000000, true, 1, 1),
        ("edge-00718", 100000000000, 999999999999999, 1000000000000000, true, 1, 1),
        ("edge-00739", 1000000000000, 999999999999999, 1000000000000000, true, 1, 1),
        ("grid-00195", 10000000, 2500000, 600000000, true, 1000000, 1),
        ("grid-00486", 100000000, 1, 100000000, true, 10000000, 2789219),
        ("grid-00583", 100000000, 25000000, 25000000, true, 10000000, 5124948),
        ("grid-00874", 1000000000, 0, 60000000000, true, 100000000, 1),
        ("grid-01068", 1000000000, 1000000000, 3000000000, false, 3000000000, 2879787338),
        ("grid-01456", 10000000000, 10000000000, 1, true, 1000000000, 740736376),
        ("grid-01747", 100000000000, 1, 1200000000000, false, 300000000000, 299999416171),
        ("grid-02329", 1000000000000, 1000000000000, 60000000000000, true, 100000000000, 1),
    ];

    /// `(id, b, q_yes, q_no, is_yes, shares, collateral_out)`
    pub const SELLS: &[(&str, u64, u64, u64, bool, u64, u64)] = &[
        ("edge-00116", 10000000, 1000000000000000, 0, true, 1, 1),
        ("edge-00158", 1000000000, 1000000000000000, 0, true, 1, 1),
        ("edge-00200", 999999999999, 1000000000000000, 0, true, 1, 1),
        ("edge-00257", 10000000, 500000000000, 0, true, 10000000, 10000000),
        ("edge-00339", 1000000000, 50000000000, 0, true, 1000000000, 999999999),
        ("edge-00422", 100000000000, 50000000000000, 0, true, 100000000000, 100000000000),
        ("edge-00495", 100000000, 0, 1, false, 1, 0),
        ("edge-00555", 10000000000, 0, 1, false, 1, 0),
        ("edge-00615", 1000000000000, 0, 1, false, 1, 0),
        ("edge-00646", 10000000, 10000000, 10000000, false, 10000000, 3798854),
        ("edge-00664", 100000000, 1000000, 1000000, false, 1000000, 498750),
        ("edge-00682", 1000000000, 1, 1, false, 1, 0),
        ("edge-00694", 1000000000, 1000000000000000, 1000000000000000, false, 1000000000000000, 693147180),
        ("edge-00712", 10000000000, 1000000000000, 1000000000000, false, 1000000000000, 6931471805),
        ("edge-00730", 100000000000, 100000000000, 100000000000, false, 100000000000, 37988549304),
        ("edge-00748", 1000000000000, 1000000, 1000000, false, 1000000, 499999),
        ("edge-00123", 10000000, 0, 1000000000000000, false, 1, 1),
        ("edge-00130", 12345678, 1000000000000000, 0, true, 1, 1),
        ("edge-00137", 12345678, 0, 1000000000000000, false, 1, 1),
        ("edge-00144", 100000000, 1000000000000000, 0, true, 1, 1),
        ("edge-00151", 100000000, 0, 1000000000000000, false, 1, 1),
        ("edge-00165", 1000000000, 0, 1000000000000000, false, 1, 1),
        ("edge-00172", 10000000000, 1000000000000000, 0, true, 1, 1),
        ("edge-00179", 10000000000, 0, 1000000000000000, false, 1, 1),
        ("edge-00186", 100000000000, 1000000000000000, 0, true, 1, 1),
        ("edge-00193", 100000000000, 0, 1000000000000000, false, 1, 1),
        ("edge-00207", 999999999999, 0, 1000000000000000, false, 1, 1),
        ("edge-00214", 1000000000000, 1000000000000000, 0, true, 1, 1),
        ("edge-00221", 1000000000000, 0, 1000000000000000, false, 1, 1),
        ("edge-00458", 10000000, 1, 0, true, 1, 0),
        ("edge-00465", 10000000, 0, 1, false, 1, 0),
        ("edge-00468", 10000000, 10000000, 10000000, true, 1, 0),
        ("edge-00471", 10000000, 10000000, 10000000, false, 1, 0),
        ("edge-00474", 10000000, 10000000, 0, true, 1, 0),
        ("edge-00479", 10000000, 999999999999999, 0, true, 1, 1),
        ("edge-00488", 100000000, 1, 0, true, 1, 0),
        ("edge-00498", 100000000, 100000000, 100000000, true, 1, 0),
        ("edge-00501", 100000000, 100000000, 100000000, false, 1, 0),
        ("edge-00504", 100000000, 100000000, 0, true, 1, 0),
        ("edge-00509", 100000000, 999999999999999, 0, true, 1, 1),
        ("edge-00518", 1000000000, 1, 0, true, 1, 0),
        ("edge-00525", 1000000000, 0, 1, false, 1, 0),
        ("edge-00528", 1000000000, 1000000000, 1000000000, true, 1, 0),
        ("edge-00531", 1000000000, 1000000000, 1000000000, false, 1, 0),
        ("edge-00534", 1000000000, 1000000000, 0, true, 1, 0),
        ("edge-00539", 1000000000, 999999999999999, 0, true, 1, 1),
        ("edge-00548", 10000000000, 1, 0, true, 1, 0),
        ("edge-00558", 10000000000, 10000000000, 10000000000, true, 1, 0),
        ("edge-00561", 10000000000, 10000000000, 10000000000, false, 1, 0),
        ("edge-00564", 10000000000, 10000000000, 0, true, 1, 0),
        ("edge-00569", 10000000000, 999999999999999, 0, true, 1, 1),
        ("edge-00578", 100000000000, 1, 0, true, 1, 0),
        ("edge-00585", 100000000000, 0, 1, false, 1, 0),
        ("edge-00588", 100000000000, 100000000000, 100000000000, true, 1, 0),
        ("edge-00591", 100000000000, 100000000000, 100000000000, false, 1, 0),
        ("edge-00594", 100000000000, 100000000000, 0, true, 1, 0),
        ("edge-00599", 100000000000, 999999999999999, 0, true, 1, 1),
        ("edge-00608", 1000000000000, 1, 0, true, 1, 0),
        ("edge-00618", 1000000000000, 1000000000000, 1000000000000, true, 1, 0),
        ("edge-00621", 1000000000000, 1000000000000, 1000000000000, false, 1, 0),
        ("edge-00624", 1000000000000, 1000000000000, 0, true, 1, 0),
        ("edge-00629", 1000000000000, 999999999999999, 0, true, 1, 1),
        ("edge-00640", 10000000, 1, 1, false, 1, 0),
        ("edge-00641", 10000000, 1, 1000000000000000, true, 1, 0),
        ("edge-00661", 100000000, 1, 1, false, 1, 0),
        ("edge-00662", 100000000, 1, 1000000000000000, true, 1, 0),
        ("edge-00683", 1000000000, 1, 1000000000000000, true, 1, 0),
        ("edge-00703", 10000000000, 1, 1, false, 1, 0),
        ("edge-00704", 10000000000, 1, 1000000000000000, true, 1, 0),
        ("edge-00724", 100000000000, 1, 1, false, 1, 0),
        ("edge-00725", 100000000000, 1, 1000000000000000, true, 1, 0),
        ("edge-00745", 1000000000000, 1, 1, false, 1, 0),
        ("edge-00746", 1000000000000, 1, 1000000000000000, true, 1, 0),
        ("grid-00292", 10000000, 30000000, 30000000, false, 15000000, 4917339),
        ("grid-00680", 100000000, 300000000, 1, true, 100000000, 92165933),
        ("grid-01262", 10000000000, 0, 100000000, false, 50000000, 25093749),
        ("grid-01553", 10000000000, 30000000000, 600000000000, true, 10000000000, 0),
        ("grid-01941", 100000000000, 300000000000, 25000000000, true, 100000000000, 90174343856),
        ("grid-02426", 1000000000000, 12000000000000, 3000000000000, false, 1500000000000, 95866119),
    ];

    /// `(id, b, q_yes, q_no, is_yes, collateral, shares)` — unclamped, so some
    /// entries exceed `MAX_Q` by design (see `shares_for_cost` docs).
    pub const SHARES_FOR_COST: &[(&str, u64, u64, u64, bool, u64, u64)] = &[
        ("edge-00452", 1000000000000, 500000000000000, 0, false, 1, 472368978884071),
        ("edge-00632", 1000000000000, 999999999999999, 0, false, 1, 972368978884070),
        ("edge-00445", 1000000000000, 50000000000000, 0, false, 1, 22368978884264),
        ("edge-00424", 100000000000, 50000000000000, 0, false, 1, 47467156397707),
        ("edge-00431", 100000000000, 500000000000000, 0, false, 1, 497467156397707),
        ("edge-00602", 100000000000, 999999999999999, 0, false, 1, 997467156397706),
        ("edge-00417", 100000000000, 5000000000000, 0, false, 1, 2467156397708),
        ("edge-00389", 10000000000, 5000000000000, 0, false, 1, 4769741490701),
        ("edge-00396", 10000000000, 50000000000000, 0, false, 1, 49769741490701),
        ("edge-00403", 10000000000, 500000000000000, 0, false, 1, 499769741490701),
        ("edge-00572", 10000000000, 999999999999999, 0, false, 1, 999769741490700),
        ("edge-00382", 10000000000, 500000000000, 0, false, 1, 269741490701),
        ("edge-00216", 1000000000000, 1000000000000000, 0, false, 1000000, 986184489942035),
        ("edge-00223", 1000000000000, 0, 1000000000000000, true, 1000000, 986184489942035),
        ("edge-00202", 999999999999, 1000000000000000, 0, false, 1000000, 986184489942050),
        ("edge-00209", 999999999999, 0, 1000000000000000, true, 1000000, 986184489942050),
        ("edge-00348", 1000000000, 500000000000, 0, false, 1, 479276734163),
        ("edge-00355", 1000000000, 5000000000000, 0, false, 1, 4979276734163),
        ("edge-00362", 1000000000, 50000000000000, 0, false, 1, 49979276734163),
        ("edge-00368", 1000000000, 1000000000000000, 0, false, 1, 999979276734163),
        ("edge-00542", 1000000000, 999999999999999, 0, false, 1, 999979276734162),
        ("edge-00341", 1000000000, 50000000000, 0, false, 1, 29276734163),
        ("edge-00188", 100000000000, 1000000000000000, 0, false, 1000000, 998848707953503),
        ("edge-00195", 100000000000, 0, 1000000000000000, true, 1000000, 998848707953503),
        ("edge-00300", 100000000, 50000000000, 0, false, 1, 48157931926),
        ("edge-00307", 100000000, 500000000000, 0, false, 1, 498157931926),
        ("edge-00314", 100000000, 5000000000000, 0, false, 1, 4998157931926),
        ("edge-00321", 100000000, 100000000000000, 0, false, 1, 99998157931926),
        ("edge-00327", 100000000, 1000000000000000, 0, false, 1, 999998157931926),
        ("edge-00512", 100000000, 999999999999999, 0, false, 1, 999998157931925),
        ("edge-00293", 100000000, 5000000000, 0, false, 1, 3157931926),
        ("edge-00438", 1000000000000, 5000000000000, 0, false, 1, 149),
        ("edge-00174", 10000000000, 1000000000000000, 0, false, 1000000, 999907897096284),
        ("edge-00181", 10000000000, 0, 1000000000000000, true, 1000000, 999907897096284),
        ("edge-00245", 10000000, 5000000000, 0, false, 1, 4838819043),
        ("edge-00252", 10000000, 50000000000, 0, false, 1, 49838819043),
        ("edge-00119", 10000000, 1000000000000000, 0, true, 1000000, 1000000),
        ("edge-00126", 10000000, 0, 1000000000000000, false, 1000000, 1000000),
        ("edge-00133", 12345678, 1000000000000000, 0, true, 1000000, 1000000),
        ("edge-00140", 12345678, 0, 1000000000000000, false, 1000000, 1000000),
        ("edge-00147", 100000000, 1000000000000000, 0, true, 1000000, 1000000),
        ("edge-00154", 100000000, 0, 1000000000000000, false, 1000000, 1000000),
        ("edge-00161", 1000000000, 1000000000000000, 0, true, 1000000, 1000000),
        ("edge-00168", 1000000000, 0, 1000000000000000, false, 1000000, 1000000),
        ("edge-00175", 10000000000, 1000000000000000, 0, true, 1000000, 1000000),
        ("edge-00182", 10000000000, 0, 1000000000000000, false, 1000000, 1000000),
        ("edge-00189", 100000000000, 1000000000000000, 0, true, 1000000, 1000000),
        ("edge-00196", 100000000000, 0, 1000000000000000, false, 1000000, 1000000),
        ("edge-00203", 999999999999, 1000000000000000, 0, true, 1000000, 1000000),
        ("edge-00210", 999999999999, 0, 1000000000000000, false, 1000000, 1000000),
        ("edge-00217", 1000000000000, 1000000000000000, 0, true, 1000000, 1000000),
        ("edge-00224", 1000000000000, 0, 1000000000000000, false, 1000000, 1000000),
        ("edge-00278", 10000000, 1000000000000000, 0, true, 10000000, 10000000),
        ("edge-00326", 100000000, 1000000000000000, 0, true, 100000000, 100000000),
        ("edge-00367", 1000000000, 1000000000000000, 0, true, 1000000000, 1000000000),
        ("edge-00769", 10000000, 0, 0, true, 1000000000000000, 1000000006931471),
        ("edge-00770", 10000000, 10000000, 0, false, 1000000000000000, 1000000013132616),
        ("edge-00781", 100000000, 0, 0, true, 1000000000000000, 1000000069314718),
        ("edge-00782", 100000000, 100000000, 0, false, 1000000000000000, 1000000131326168),
        ("edge-00793", 1000000000, 0, 0, true, 1000000000000000, 1000000693147180),
        ("edge-00794", 1000000000, 1000000000, 0, false, 1000000000000000, 1000001313261687),
        ("edge-00805", 10000000000, 0, 0, true, 1000000000000000, 1000006931471805),
        ("edge-00806", 10000000000, 10000000000, 0, false, 1000000000000000, 1000013132616875),
        ("edge-00817", 100000000000, 0, 0, true, 1000000000000000, 1000069314718055),
        ("edge-00818", 100000000000, 100000000000, 0, false, 1000000000000000, 1000131326168751),
        ("edge-00829", 1000000000000, 0, 0, true, 1000000000000000, 1000693147180559),
        ("edge-00830", 1000000000000, 1000000000000, 0, false, 1000000000000000, 1001313261687518),
        ("edge-00839", 10000000, 1000000000000000, 0, false, 100000000, 1000000099999545),
        ("edge-00840", 10000000, 0, 1000000000000000, true, 100000000, 1000000099999545),
        ("edge-00841", 10000000, 1000000000000000, 0, false, 1000000000, 1000000999999999),
        ("edge-00842", 10000000, 0, 1000000000000000, true, 1000000000, 1000000999999999),
        ("edge-00851", 100000000, 1000000000000000, 0, false, 1000000000, 1000000999995459),
        ("edge-00852", 100000000, 0, 1000000000000000, true, 1000000000, 1000000999995459),
        ("edge-00853", 100000000, 1000000000000000, 0, false, 10000000000, 1000009999999999),
        ("edge-00854", 100000000, 0, 1000000000000000, true, 10000000000, 1000009999999999),
        ("edge-00863", 1000000000, 1000000000000000, 0, false, 10000000000, 1000009999954599),
        ("edge-00864", 1000000000, 0, 1000000000000000, true, 10000000000, 1000009999954599),
        ("edge-00865", 1000000000, 1000000000000000, 0, false, 100000000000, 1000099999999999),
        ("edge-00866", 1000000000, 0, 1000000000000000, true, 100000000000, 1000099999999999),
        ("edge-00875", 10000000000, 1000000000000000, 0, false, 100000000000, 1000099999545990),
        ("edge-00876", 10000000000, 0, 1000000000000000, true, 100000000000, 1000099999545990),
        ("edge-00877", 10000000000, 1000000000000000, 0, false, 1000000000000, 1000999999999999),
        ("edge-00878", 10000000000, 0, 1000000000000000, true, 1000000000000, 1000999999999999),
        ("edge-00887", 100000000000, 1000000000000000, 0, false, 1000000000000, 1000999995459903),
        ("edge-00888", 100000000000, 0, 1000000000000000, true, 1000000000000, 1000999995459903),
        ("edge-00889", 100000000000, 1000000000000000, 0, false, 10000000000000, 1009999999999999),
        ("edge-00890", 100000000000, 0, 1000000000000000, true, 10000000000000, 1009999999999999),
        ("edge-00895", 1000000000000, 1000000000000000, 0, false, 10000000000000, 1009999954599039),
        ("edge-00896", 1000000000000, 0, 1000000000000000, true, 10000000000000, 1009999954599039),
        ("edge-00897", 1000000000000, 1000000000000000, 0, false, 100000000000000, 1099999999999999),
        ("edge-00898", 1000000000000, 0, 1000000000000000, true, 100000000000000, 1099999999999999),
        ("edge-00004", 10000000, 0, 0, true, 1, 1),
        ("edge-00340", 1000000000, 50000000000, 0, true, 1000000000, 1000000000),
        ("edge-00469", 10000000, 10000000, 10000000, true, 1, 1),
        ("edge-00570", 10000000000, 999999999999999, 0, true, 1, 1),
        ("edge-00773", 100000000, 0, 0, true, 2, 3),
        ("edge-00813", 100000000000, 0, 0, true, 1000000000, 1990098929),
        ("edge-00893", 1000000000000, 500000000000000, 0, false, 100000000000000, 599999999999999),
        ("grid-00098", 10000000, 100000, 0, false, 20000000, 26277308),
        ("grid-00777", 100000000, 1200000000, 6000000000, true, 25000000, 4674130845),
        ("grid-00971", 1000000000, 10000000, 12000000000, false, 2000000000, 2000005366),
        ("grid-01165", 1000000000, 12000000000, 250000000, true, 250000000, 250001745),
        ("grid-01359", 10000000000, 100000000, 100000000, false, 20000000000, 26230812603),
        ("grid-01650", 10000000000, 600000000000, 30000000000, false, 20000000000, 588545865421),
        ("grid-02038", 100000000000, 6000000000000, 1, false, 200000000000, 6185458654212),
        ("grid-02135", 1000000000000, 1, 1, true, 250000000000, 449833340647),
        ("grid-02232", 1000000000000, 250000000000, 0, false, 2000000000000, 2746807122015),
        ("grid-02125", 1000000000000, 0, 60000000000000, true, 250000000000, 58741308450553),
        ("grid-02171", 1000000000000, 1, 60000000000000, true, 250000000000, 58741308450552),
        ("grid-02225", 1000000000000, 10000000000, 60000000000000, true, 250000000000, 58731308450553),
        ("grid-02279", 1000000000000, 250000000000, 60000000000000, true, 250000000000, 58491308450553),
        ("grid-02333", 1000000000000, 1000000000000, 60000000000000, true, 250000000000, 57741308450553),
        ("grid-02387", 1000000000000, 3000000000000, 60000000000000, true, 250000000000, 55741308450553),
        ("grid-02441", 1000000000000, 12000000000000, 60000000000000, true, 250000000000, 46741308450553),
        ("grid-02119", 1000000000000, 0, 12000000000000, true, 250000000000, 10741336226995),
        ("grid-02165", 1000000000000, 1, 12000000000000, true, 250000000000, 10741336226994),
        ("grid-02218", 1000000000000, 10000000000, 12000000000000, true, 250000000000, 10731336506149),
        ("grid-02272", 1000000000000, 250000000000, 12000000000000, true, 250000000000, 10491344116069),
        ("grid-02326", 1000000000000, 1000000000000, 12000000000000, true, 250000000000, 9741383952947),
        ("grid-02380", 1000000000000, 3000000000000, 12000000000000, true, 250000000000, 7741866207460),
        ("grid-02113", 1000000000000, 0, 3000000000000, true, 250000000000, 1944312932854),
        ("grid-02159", 1000000000000, 1, 3000000000000, true, 250000000000, 1944312932853),
        ("grid-02211", 1000000000000, 10000000000, 3000000000000, true, 250000000000, 1936157701364),
        ("grid-02265", 1000000000000, 250000000000, 3000000000000, true, 250000000000, 1745179690101),
        ("grid-02319", 1000000000000, 1000000000000, 3000000000000, true, 250000000000, 1218675730846),
        ("grid-02107", 1000000000000, 0, 1000000000000, true, 250000000000, 720804440914),
        ("grid-02153", 1000000000000, 1, 1000000000000, true, 250000000000, 720804440914),
    ];

    /// `(b, ceil(b·ln2), cost(0, 0, b))`
    pub const MAX_LOSS: &[(u64, u64, u64)] = &[
        (10000000, 6931472, 6931471),
        (12345678, 8557372, 8557371),
        (100000000, 69314719, 69314718),
        (1000000000, 693147181, 693147180),
        (10000000000, 6931471806, 6931471805),
        (100000000000, 69314718056, 69314718055),
        (777777777777, 539114473769, 539114473768),
        (1000000000000, 693147180560, 693147180559),
    ];
}

#[cfg(test)]
mod tests {
    use super::vectors;
    use super::*;
    use crate::bounds::{B_MAX, B_MIN, MAX_Q};
    use std::{format, println, string::String, vec::Vec};

    /// `round(ln 2 · 2^80)`, an independent high-precision constant (not
    /// `Fixed::LN_2`, which is what we are checking). `b · LN2_Q80 >> 16` is
    /// `b·ln2` in Q64.64 to within `4.2e-13` base units for every legal `b`.
    const LN2_Q80: u128 = 837_963_523_372_001_241_319_908;

    fn side(is_yes: bool) -> Outcome {
        if is_yes {
            Outcome::Yes
        } else {
            Outcome::No
        }
    }

    /// Skew `|q_yes − q_no| / b` below which Q64.64 and the oracle's 60-digit
    /// arithmetic must agree to the base unit.
    ///
    /// Beyond it they can differ by exactly 1: the minority weight `e^-skew`
    /// falls below what Q64.64 can represent (`2^-64`, even after the scaling
    /// in [`b_small_softplus`]) while `mpmath` still carries it, so a result
    /// sitting infinitesimally below an integer rounds the other way. Measured
    /// against all 3,988 committed vectors, the first disagreement is at skew
    /// 59; this uses 48 as the asserted-exact margin.
    const EXACT_SKEW_LIMIT: u128 = 48;

    fn within_exact_range(q_yes: u64, q_no: u64, b: u64) -> bool {
        let d = u128::from(q_yes.max(q_no) - q_yes.min(q_no));
        d < EXACT_SKEW_LIMIT * u128::from(b)
    }

    /// Exact equality inside the well-conditioned range, `±1` outside it.
    fn assert_agrees(id: &str, what: &str, got: u64, want: u64, q_yes: u64, q_no: u64, b: u64) -> bool {
        if got == want {
            return false;
        }
        assert!(
            !within_exact_range(q_yes, q_no, b),
            "{id}: {what} = {got}, oracle {want} at skew \
             {}/{b}, inside the exact-agreement range",
            q_yes.max(q_no) - q_yes.min(q_no)
        );
        let delta = i128::from(got) - i128::from(want);
        assert!(
            delta.abs() <= 1,
            "{id}: {what} = {got}, oracle {want} (delta {delta}); \
             extreme skew may cost 1 base unit, never more"
        );
        true
    }

    /// `b·ln2` as an exact-enough Q64.64 raw value.
    fn b_ln2_raw(b: u64) -> i128 {
        ((u128::from(b) * LN2_Q80) >> 16) as i128
    }

    // -- oracle conformance spot-checks -----------------------------------

    #[test]
    fn oracle_states_match() {
        let (mut checked, mut off) = (0usize, 0usize);
        for &(id, b, q_yes, q_no, want_cost, want_py) in vectors::STATES {
            let got_cost = cost(q_yes, q_no, b).unwrap_or_else(|e| panic!("{id}: {e}"));
            // `cost` agrees with the oracle everywhere, including at 1e8 skew.
            assert_eq!(got_cost, want_cost, "{id}: cost({q_yes}, {q_no}, {b})");
            let got_py = price_yes(q_yes, q_no, b).unwrap_or_else(|e| panic!("{id}: {e}"));
            off += usize::from(assert_agrees(id, "price_yes", got_py, want_py, q_yes, q_no, b));
            let got_pn = price_no(q_yes, q_no, b).unwrap_or_else(|e| panic!("{id}: {e}"));
            assert_eq!(got_py + got_pn, UNIT, "{id}: prices must sum to UNIT");
            checked += 1;
        }
        println!("oracle states: {checked} checked, {off} price off by 1 at extreme skew");
        assert!(checked >= 100);
    }

    #[test]
    fn oracle_buys_match() {
        let mut off = 0usize;
        for &(id, b, q_yes, q_no, is_yes, shares, want) in vectors::BUYS {
            let got = buy_cost(q_yes, q_no, b, side(is_yes), shares)
                .unwrap_or_else(|e| panic!("{id}: {e}"));
            off += usize::from(assert_agrees(id, "buy_cost", got, want, q_yes, q_no, b));
        }
        println!("oracle buys: {} checked, {off} off by 1", vectors::BUYS.len());
    }

    #[test]
    fn oracle_sells_match() {
        let mut off = 0usize;
        for &(id, b, q_yes, q_no, is_yes, shares, want) in vectors::SELLS {
            let got = sell_return(q_yes, q_no, b, side(is_yes), shares)
                .unwrap_or_else(|e| panic!("{id}: {e}"));
            off += usize::from(assert_agrees(id, "sell_return", got, want, q_yes, q_no, b));
        }
        println!("oracle sells: {} checked, {off} off by 1", vectors::SELLS.len());
    }

    /// The one the whole ticket turns on: the closed form must survive deep
    /// skew, tiny spends and the unclamped `exceeds_max_q` results.
    #[test]
    fn oracle_shares_for_cost_match() {
        let (mut over_max_q, mut off) = (0usize, 0usize);
        for &(id, b, q_yes, q_no, is_yes, collateral, want) in vectors::SHARES_FOR_COST {
            let o = side(is_yes);
            let got = shares_for_cost(q_yes, q_no, b, o, collateral)
                .unwrap_or_else(|e| panic!("{id}: {e}"));
            off += usize::from(assert_agrees(id, "shares_for_cost", got, want, q_yes, q_no, b));
            if o.select(q_yes, q_no).saturating_add(got) > MAX_Q {
                over_max_q += 1;
            }
        }
        println!(
            "oracle shares_for_cost: {} checked, {off} off by 1, \
             {over_max_q} unclamped past MAX_Q",
            vectors::SHARES_FOR_COST.len()
        );
        assert!(
            over_max_q > 0,
            "the sample must include exceeds_max_q cases (ticket 5c)"
        );
    }

    #[test]
    fn oracle_max_loss_constants_match_exactly() {
        for &(b, want_bound, want_origin) in vectors::MAX_LOSS {
            assert_eq!(max_loss_bound(b).unwrap(), want_bound, "max_loss_bound({b})");
            assert_eq!(cost(0, 0, b).unwrap(), want_origin, "cost(0, 0, {b})");
        }
    }

    // -- plan 1.4: the max-loss bound under fixed point --------------------

    /// `cost(0, 0, b) == b·ln2` across the whole legal `b` range, measured
    /// against an independent 80-bit `ln 2` rather than `Fixed::LN_2`.
    #[test]
    fn max_loss_bound_holds_across_the_legal_b_range() {
        let mut worst_ulp: i128 = 0;
        let mut worst_b = 0u64;
        let mut checked = 0usize;

        let probe = |b: u64, worst_ulp: &mut i128, worst_b: &mut u64, checked: &mut usize| {
            let got = cost_fixed(0, 0, b).expect("cost_fixed").to_raw();
            let want = b_ln2_raw(b);
            let d = (got - want).abs();
            if d > *worst_ulp {
                *worst_ulp = d;
                *worst_b = b;
            }
            // The integer answers must agree exactly with floor / ceil.
            assert_eq!(
                cost(0, 0, b).unwrap(),
                (want >> 64) as u64,
                "cost(0,0,{b}) floor"
            );
            let ceil = ((want >> 64) + i128::from(want & ((1i128 << 64) - 1) != 0)) as u64;
            assert_eq!(max_loss_bound(b).unwrap(), ceil, "max_loss_bound({b}) ceil");
            *checked += 1;
        };

        // Both endpoints, a geometric sweep, and a dense linear sweep.
        for b in [B_MIN, B_MIN + 1, B_MAX - 1, B_MAX] {
            probe(b, &mut worst_ulp, &mut worst_b, &mut checked);
        }
        let mut b = B_MIN;
        while b <= B_MAX {
            probe(b, &mut worst_ulp, &mut worst_b, &mut checked);
            for k in 1..=9u64 {
                let v = b.saturating_add(b / 10 * k);
                if (B_MIN..=B_MAX).contains(&v) {
                    probe(v, &mut worst_ulp, &mut worst_b, &mut checked);
                }
            }
            b = match b.checked_mul(2) {
                Some(v) => v,
                None => break,
            };
        }
        let step = (B_MAX - B_MIN) / 400;
        let mut b = B_MIN;
        while b <= B_MAX {
            probe(b, &mut worst_ulp, &mut worst_b, &mut checked);
            b += step;
        }

        // 1 ulp = 2^-64 base units.
        let worst_units = worst_ulp as f64 / 18_446_744_073_709_551_616.0;
        println!(
            "max-loss (b*ln2): {checked} values of b, worst deviation {worst_ulp} ulp \
             = {worst_units:.3e} base units (at b = {worst_b})"
        );
        assert!(
            worst_units < 1e-6,
            "b*ln2 deviation {worst_units:e} base units is too large"
        );
    }

    // -- invariants (ticket item 7) ---------------------------------------

    #[test]
    fn prices_always_sum_to_unit_exactly() {
        let mut n = 0usize;
        for &b in &[B_MIN, 12_345_678u64, 100_000_000, 1_000_000_000, 1e11 as u64, B_MAX] {
            for &q_yes in &[
                0u64,
                1,
                UNIT,
                b / 3,
                b,
                3 * b,
                60 * b,
                1_000_000_000_000,
                MAX_Q,
            ] {
                for &q_no in &[0u64, 1, UNIT, b / 7, b, 5 * b, 60 * b, MAX_Q] {
                    if q_yes > MAX_Q || q_no > MAX_Q {
                        continue;
                    }
                    let py = price_yes(q_yes, q_no, b).unwrap();
                    let pn = price_no(q_yes, q_no, b).unwrap();
                    assert_eq!(py + pn, UNIT, "({q_yes}, {q_no}, {b})");
                    assert!(py <= UNIT);
                    n += 1;
                }
            }
        }
        println!("price-sum states checked: {n}");
        assert!(n > 300);
    }

    #[test]
    fn buy_then_sell_never_profits() {
        let mut worst_margin = u64::MAX;
        let mut n = 0usize;
        for &b in &[B_MIN, 100_000_000u64, 10_000_000_000, B_MAX] {
            for &(q_yes, q_no) in &[
                (0u64, 0u64),
                (b, 0),
                (0, b),
                (3 * b, b / 2),
                (50 * b, 0),
                (MAX_Q, 0),
                (12_345_678_901, 98_765_432_109),
            ] {
                if q_yes > MAX_Q || q_no > MAX_Q {
                    continue;
                }
                for &shares in &[1u64, 1_000, UNIT, 100 * UNIT, b, 10 * b] {
                    for o in [Outcome::Yes, Outcome::No] {
                        if o.select(q_yes, q_no).saturating_add(shares) > MAX_Q {
                            continue;
                        }
                        let paid = buy_cost(q_yes, q_no, b, o, shares).unwrap();
                        let (n_yes, n_no) = match o {
                            Outcome::Yes => (q_yes + shares, q_no),
                            Outcome::No => (q_yes, q_no + shares),
                        };
                        let got = sell_return(n_yes, n_no, b, o, shares).unwrap();
                        assert!(
                            got <= paid,
                            "round trip profited: paid {paid}, got {got} \
                             ({q_yes}, {q_no}, {b}, {o:?}, {shares})"
                        );
                        worst_margin = worst_margin.min(paid - got);
                        n += 1;
                    }
                }
            }
        }
        println!("round trips: {n}, tightest protocol margin {worst_margin} base units");
    }

    #[test]
    fn buying_moves_that_price_up_monotonically() {
        for &b in &[B_MIN, 500_000_000u64, B_MAX] {
            for &(q_yes, q_no) in &[(0u64, 0u64), (b, 2 * b), (10 * b, 0), (0, 10 * b)] {
                let mut y = q_yes;
                let mut prev = price_yes(y, q_no, b).unwrap();
                for _ in 0..40 {
                    y += b / 4 + 1;
                    if y > MAX_Q {
                        break;
                    }
                    let p = price_yes(y, q_no, b).unwrap();
                    assert!(
                        p >= prev,
                        "price_yes went down: {prev} -> {p} at ({y}, {q_no}, {b})"
                    );
                    prev = p;
                }
                // And the NO price moves the other way, by construction.
                let mut n = q_no;
                let mut prev = price_no(q_yes, n, b).unwrap();
                for _ in 0..40 {
                    n += b / 4 + 1;
                    if n > MAX_Q {
                        break;
                    }
                    let p = price_no(q_yes, n, b).unwrap();
                    assert!(p >= prev);
                    prev = p;
                }
            }
        }
    }

    /// Ticket item 6's post-condition: whatever `shares_for_cost` returns must
    /// actually be affordable.
    #[test]
    fn shares_for_cost_is_always_affordable() {
        let mut n = 0usize;
        let mut worst_slack = u64::MAX;
        for &(id, b, q_yes, q_no, is_yes, collateral, _want) in vectors::SHARES_FOR_COST {
            let o = side(is_yes);
            let d = shares_for_cost(q_yes, q_no, b, o, collateral).unwrap();
            if o.select(q_yes, q_no).saturating_add(d) > MAX_Q {
                continue; // the program would reject this trade; buy_cost refuses it
            }
            let paid = buy_cost(q_yes, q_no, b, o, d).unwrap();
            assert!(
                paid <= collateral,
                "{id}: buy_cost of {d} shares is {paid} > {collateral} spent"
            );
            worst_slack = worst_slack.min(collateral - paid);
            n += 1;
        }
        println!("shares_for_cost affordability: {n} cases, tightest slack {worst_slack}");
        assert!(n > 50);
    }

    #[test]
    fn shares_for_cost_is_monotone_in_collateral() {
        for &b in &[B_MIN, 1_000_000_000u64, B_MAX] {
            for &(q_yes, q_no) in &[(0u64, 0u64), (MAX_Q, 0), (30 * b, 0), (b, 3 * b)] {
                if q_yes > MAX_Q || q_no > MAX_Q {
                    continue;
                }
                for o in [Outcome::Yes, Outcome::No] {
                    let mut prev = 0u64;
                    for k in 0..30u64 {
                        let x = k * k * UNIT + k;
                        let d = shares_for_cost(q_yes, q_no, b, o, x).unwrap();
                        assert!(d >= prev, "not monotone at x={x}: {prev} -> {d}");
                        prev = d;
                    }
                }
            }
        }
    }

    // -- domain / error behaviour -----------------------------------------

    #[test]
    fn out_of_range_inputs_are_rejected() {
        assert_eq!(cost(0, 0, B_MIN - 1), Err(LmsrError::BOutOfRange));
        assert_eq!(cost(0, 0, B_MAX + 1), Err(LmsrError::BOutOfRange));
        assert_eq!(cost(MAX_Q + 1, 0, B_MIN), Err(LmsrError::QOutOfRange));
        assert_eq!(cost(0, u64::MAX, B_MIN), Err(LmsrError::QOutOfRange));
        assert_eq!(price_yes(0, 0, 0), Err(LmsrError::BOutOfRange));
        assert_eq!(price_no(0, 0, u64::MAX), Err(LmsrError::BOutOfRange));
        assert_eq!(
            buy_cost(MAX_Q, 0, B_MIN, Outcome::Yes, 1),
            Err(LmsrError::QOutOfRange)
        );
        assert_eq!(
            sell_return(10, 0, B_MIN, Outcome::Yes, 11),
            Err(LmsrError::InsufficientShares)
        );
        assert_eq!(
            sell_return(0, 0, B_MIN, Outcome::No, 1),
            Err(LmsrError::InsufficientShares)
        );
        assert_eq!(
            shares_for_cost(0, 0, B_MIN - 1, Outcome::Yes, 1),
            Err(LmsrError::BOutOfRange)
        );
    }

    #[test]
    fn zero_amount_trades_are_free() {
        for &b in &[B_MIN, B_MAX] {
            for o in [Outcome::Yes, Outcome::No] {
                assert_eq!(buy_cost(7 * b, b, b, o, 0), Ok(0));
                assert_eq!(sell_return(7 * b, b, b, o, 0), Ok(0));
                assert_eq!(shares_for_cost(7 * b, b, b, o, 0), Ok(0));
            }
        }
    }

    /// Ticket 5d: at extreme skew a small buy of the worthless side is exactly
    /// free, and that is the oracle's answer too.
    #[test]
    fn zero_cost_trades_at_extreme_skew_are_correct() {
        let b = B_MIN;
        let q_yes = MAX_Q; // (q_no - q_yes)/b = -1e8
        assert_eq!(cost(q_yes, 0, b), Ok(q_yes));
        assert_eq!(price_yes(q_yes, 0, b), Ok(UNIT));
        assert_eq!(price_no(q_yes, 0, b), Ok(0));
        assert_eq!(buy_cost(q_yes, 0, b, Outcome::No, UNIT), Ok(0));
        // Buying the certain side costs exactly its face value.
        assert_eq!(buy_cost(q_yes - UNIT, 0, b, Outcome::Yes, UNIT), Ok(UNIT));
    }

    #[test]
    fn market_open_is_exactly_fifty_fifty() {
        for &b in &[B_MIN, 12_345_678u64, 999_999_999_999, B_MAX] {
            assert_eq!(price_yes(0, 0, b), Ok(UNIT / 2));
            assert_eq!(price_no(0, 0, b), Ok(UNIT / 2));
            assert_eq!(price_yes(MAX_Q, MAX_Q, b), Ok(UNIT / 2));
        }
    }

    // -- no panics --------------------------------------------------------

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            self.0 >> 11
        }
        fn below(&mut self, n: u64) -> u64 {
            if n == 0 {
                0
            } else {
                self.next() % n
            }
        }
    }

    #[test]
    fn fuzz_never_panics_and_stays_consistent() {
        let mut rng = Lcg(0x5EED_1234_ABCD_0001);
        let mut ok = 0usize;
        let mut errs = 0usize;
        for _ in 0..60_000 {
            // A deliberate mix of in-range and wildly out-of-range values.
            let b = match rng.below(6) {
                0 => rng.next(),
                1 => B_MIN,
                2 => B_MAX,
                _ => B_MIN + rng.below(B_MAX - B_MIN + 1),
            };
            let pick_q = |r: &mut Lcg| match r.below(6) {
                0 => r.next(),
                1 => 0,
                2 => MAX_Q,
                3 => r.below(1_000_000),
                _ => r.below(MAX_Q + 1),
            };
            let q_yes = pick_q(&mut rng);
            let q_no = pick_q(&mut rng);
            let o = if rng.below(2) == 0 {
                Outcome::Yes
            } else {
                Outcome::No
            };
            let amt = match rng.below(5) {
                0 => rng.next(),
                1 => 0,
                _ => rng.below(MAX_Q + 1),
            };

            let c = cost(q_yes, q_no, b);
            let py = price_yes(q_yes, q_no, b);
            let pn = price_no(q_yes, q_no, b);
            let bc = buy_cost(q_yes, q_no, b, o, amt);
            let sr = sell_return(q_yes, q_no, b, o, amt);
            let sf = shares_for_cost(q_yes, q_no, b, o, amt);
            let ml = max_loss_bound(b);

            match (py, pn) {
                (Ok(a), Ok(x)) => {
                    assert_eq!(a + x, UNIT);
                    ok += 1;
                }
                (Err(a), Err(x)) => {
                    assert_eq!(a, x);
                    errs += 1;
                }
                other => panic!("price pair disagreed: {other:?}"),
            }
            if let (Ok(cv), Ok(mv)) = (c, ml) {
                let m = q_yes.max(q_no);
                assert!(cv >= m, "cost {cv} below max q {m}");
                assert!(cv <= m + mv, "cost {cv} above {m} + b*ln2 {mv}");
            }
            // Nothing above may panic; the values themselves are exercised by
            // the oracle tests.
            let _ = (bc, sr, sf);
        }
        println!("fuzz: {ok} in-domain, {errs} rejected, 0 panics");
        assert!(ok > 10_000 && errs > 1_000);
    }

    /// The `b·ln 2` bound must hold at every *reachable* state, not just the
    /// origin: collateral collected can never exceed the worst-case payout by
    /// more than `b·ln 2`.
    #[test]
    fn max_loss_bound_holds_at_reachable_states() {
        let mut worst: i128 = i128::MIN;
        let mut n = 0usize;
        for &b in &[B_MIN, 100_000_000u64, 10_000_000_000, B_MAX] {
            let origin = i128::from(cost(0, 0, b).unwrap());
            let bound = i128::from(max_loss_bound(b).unwrap());
            for &(q_yes, q_no) in &[
                (0u64, 0u64),
                (b, 0),
                (0, b),
                (7 * b, 3 * b),
                (60 * b, 0),
                (MAX_Q, 0),
                (MAX_Q, MAX_Q),
                (1, 0),
            ] {
                if q_yes > MAX_Q || q_no > MAX_Q {
                    continue;
                }
                let c = i128::from(cost(q_yes, q_no, b).unwrap());
                let collected = c - origin;
                for payout in [i128::from(q_yes), i128::from(q_no)] {
                    let loss = payout - collected;
                    assert!(
                        loss <= bound,
                        "loss {loss} exceeds b*ln2 {bound} at ({q_yes}, {q_no}, {b})"
                    );
                    worst = worst.max(loss);
                }
                n += 1;
            }
        }
        println!("max-loss at {n} reachable states, worst realised loss {worst}");
    }

    #[test]
    fn ln_one_minus_exp_neg_is_accurate_for_tiny_arguments() {
        // The 5b-i trap in isolation: t = X/b as small as 1e-12.
        // ln(1 - e^-t) ~ ln t for tiny t, so compare against ln(X) - ln(b)
        // plus the leading correction -t/2.
        for &(x, b) in &[(1u64, B_MAX), (1, 100_000_000_000), (7, B_MAX), (1, B_MIN)] {
            let got = ln_one_minus_exp_neg(x, b).unwrap().to_f64();
            let t = x as f64 / b as f64;
            let want = (-(-t).exp_m1()).ln();
            assert!(
                (got - want).abs() < 1e-12,
                "ln(1-e^-{t:e}): got {got}, want {want}"
            );
        }
    }

    /// A tiny summary the ticket asks to be reported.
    #[test]
    fn report_sample_sizes() {
        let names: Vec<String> = ["states", "buys", "sells", "shares_for_cost"]
            .iter()
            .zip([
                vectors::STATES.len(),
                vectors::BUYS.len(),
                vectors::SELLS.len(),
                vectors::SHARES_FOR_COST.len(),
            ])
            .map(|(n, c)| format!("{n}={c}"))
            .collect();
        println!("oracle sample: {}", names.join(" "));
    }
}
