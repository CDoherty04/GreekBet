//! Fuzz and boundary suite — plan §4.1's "fuzz near the overflow boundaries".
//!
//! # The contract this suite enforces
//!
//! > **Every input to every public function returns `Ok(_)` or `Err(LmsrError)`.
//! > A panic is a test failure.**
//!
//! That is the whole point. `lib.rs` promises "no public function panics on any
//! input"; a promise nobody tried to break is a comment. Every call below goes
//! through [`common::catch`], so an escaped `unwrap`, a slice index, a divide by
//! zero or an arithmetic overflow surfaces as a named case rather than as a
//! dead test binary.
//!
//! `overflow-checks` is on in both profiles this suite runs under — `dev` by
//! default, and `release` because the workspace root re-enables it — so a
//! wrapping subtraction is a panic here rather than a silent wrong answer.
//! **Run it both ways**; the release profile exercises differently-optimised
//! code:
//!
//! ```text
//! cargo test -p lmsr --test boundaries
//! cargo test -p lmsr --test boundaries --release
//! ```
//!
//! # Coverage
//!
//! * a hand-picked grid of `q`, `b` and trade sizes that puts **every**
//!   representable boundary — `0`, `1`, `MAX_Q ± 1`, `B_MIN ± 1`, `B_MAX ± 1`,
//!   `2^63`, `i64::MAX`, `u64::MAX` — into every argument position of every
//!   function, cartesian, ~470k calls;
//! * the harshest legal input the module can see: one side at `MAX_Q`, the
//!   other at `0`, at `b = B_MIN` — a skew of `1e8`, where `exp` has underflowed
//!   by 140,000×;
//! * 200k pseudorandom cases drawn from the **whole** `u64` range, not the legal
//!   domain, so the validators are fuzzed as hard as the maths;
//! * the `fixed` layer directly, at `i128::MIN`, `i128::MAX` and the exact
//!   `exp` overflow/underflow cut-offs.
//!
//! # Tolerances
//!
//! None. Nothing here compares a number to a reference; every assertion is
//! structural (no panic, the documented error variant, a price inside
//! `[0, UNIT]`). The one exception is [`the_harshest_legal_input`], where the
//! limiting values are exact and asserted as exact.

mod common;

use common::catch;
use lmsr::{
    buy_cost, cost, max_loss_bound, price_no, price_yes, sell_return, shares_for_cost, validate_b,
    validate_q, Fixed, FixedError, LmsrError, Outcome, B_MAX, B_MIN, MAX_Q, UNIT,
};

// ---------------------------------------------------------------------------
// The boundary grid
// ---------------------------------------------------------------------------

/// Share quantities: every documented edge plus the representation edges.
const QS: &[u64] = &[
    0,
    1,
    2,
    UNIT - 1,
    UNIT,
    UNIT + 1,
    MAX_Q / 2,
    MAX_Q - 2,
    MAX_Q - 1,
    MAX_Q,
    MAX_Q + 1,
    MAX_Q + 2,
    1 << 62,
    (1 << 63) - 1,
    1 << 63,
    u64::MAX - 1,
    u64::MAX,
];

/// Liquidity parameters, straddling both ends of the frozen range.
const BS: &[u64] = &[
    0,
    1,
    UNIT,
    B_MIN - 1,
    B_MIN,
    B_MIN + 1,
    B_MAX - 1,
    B_MAX,
    B_MAX + 1,
    MAX_Q,
    1 << 63,
    u64::MAX - 1,
    u64::MAX,
];

/// Trade sizes / collateral amounts.
const NS: &[u64] = &[
    0,
    1,
    2,
    UNIT,
    MAX_Q / 2,
    MAX_Q - 1,
    MAX_Q,
    MAX_Q + 1,
    1 << 62,
    (1 << 63) - 1,
    1 << 63,
    u64::MAX,
];

const OUTCOMES: [Outcome; 2] = [Outcome::Yes, Outcome::No];

/// Tally of what a sweep produced, so a "pass" that silently stopped calling
/// anything is visible.
#[derive(Default)]
struct Tally {
    calls: u64,
    ok: u64,
    err: u64,
    panics: Vec<String>,
}

impl Tally {
    fn record<T>(&mut self, what: &str, r: std::result::Result<lmsr::Result<T>, String>) {
        self.calls += 1;
        match r {
            Ok(Ok(_)) => self.ok += 1,
            Ok(Err(_)) => self.err += 1,
            Err(msg) => {
                if self.panics.len() < 20 {
                    self.panics.push(format!("{what}: {msg}"));
                }
            }
        }
    }

    fn finish(&self, name: &str) {
        println!(
            "  {name:<44} {:>8} calls  {:>8} Ok  {:>8} Err  {:>3} PANIC",
            self.calls,
            self.ok,
            self.err,
            self.panics.len()
        );
        assert!(
            self.panics.is_empty(),
            "{name}: {} panicking input(s); first few:\n  {}",
            self.panics.len(),
            self.panics.join("\n  ")
        );
        assert!(self.calls > 0, "{name}: swept nothing");
        // Both outcomes must occur, or the sweep is only testing one half of
        // the validator.
        assert!(self.ok > 0 && self.err > 0, "{name}: one-sided sweep");
    }
}

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

#[test]
fn state_functions_survive_the_boundary_grid() {
    let mut t = Tally::default();
    for &q_yes in QS {
        for &q_no in QS {
            for &b in BS {
                t.record("cost", catch(move || cost(q_yes, q_no, b)));
                t.record("price_yes", catch(move || price_yes(q_yes, q_no, b)));
                t.record("price_no", catch(move || price_no(q_yes, q_no, b)));

                // Whenever the state is legal, the prices must be a valid
                // probability pair — not merely non-panicking.
                if let (Ok(Ok(py)), Ok(Ok(pn))) = (
                    catch(move || price_yes(q_yes, q_no, b)),
                    catch(move || price_no(q_yes, q_no, b)),
                ) {
                    assert!(py <= UNIT, "price_yes {py} > UNIT at ({q_yes},{q_no},{b})");
                    assert_eq!(py + pn, UNIT, "prices at ({q_yes},{q_no},{b})");
                }
            }
        }
    }
    for &b in BS {
        t.record("max_loss_bound", catch(move || max_loss_bound(b)));
    }
    t.finish("state functions (cost/price/max_loss_bound)");
}

#[test]
fn trade_functions_survive_the_boundary_grid() {
    let mut buy = Tally::default();
    let mut sell = Tally::default();
    let mut inv = Tally::default();
    for &q_yes in QS {
        for &q_no in QS {
            for &b in BS {
                for o in OUTCOMES {
                    for &n in NS {
                        buy.record("buy_cost", catch(move || buy_cost(q_yes, q_no, b, o, n)));
                        sell.record(
                            "sell_return",
                            catch(move || sell_return(q_yes, q_no, b, o, n)),
                        );
                        inv.record(
                            "shares_for_cost",
                            catch(move || shares_for_cost(q_yes, q_no, b, o, n)),
                        );
                    }
                }
            }
        }
    }
    buy.finish("buy_cost");
    sell.finish("sell_return");
    inv.finish("shares_for_cost");
}

/// `u64::MAX` and `0` in every argument position of every public function,
/// spelled out rather than left to the grid — item 3 of the ticket asks for it
/// by name.
#[test]
fn zero_and_u64_max_into_every_public_function() {
    const EXTREMES: [u64; 2] = [0, u64::MAX];
    let mut t = Tally::default();
    for &a in &EXTREMES {
        for &b in &EXTREMES {
            for &c in &EXTREMES {
                t.record("cost", catch(move || cost(a, b, c)));
                t.record("price_yes", catch(move || price_yes(a, b, c)));
                t.record("price_no", catch(move || price_no(a, b, c)));
                for o in OUTCOMES {
                    for &d in &EXTREMES {
                        t.record("buy_cost", catch(move || buy_cost(a, b, c, o, d)));
                        t.record("sell_return", catch(move || sell_return(a, b, c, o, d)));
                        t.record("shares_for_cost", catch(move || shares_for_cost(a, b, c, o, d)));
                    }
                }
            }
        }
        t.record("max_loss_bound", catch(move || max_loss_bound(a)));
        assert!(catch(move || validate_b(a)).is_ok());
        assert!(catch(move || validate_q(a)).is_ok());
    }
    // Not one-sided: `cost(0, 0, u64::MAX)` errors, and every `u64::MAX` q
    // errors, but none of them succeed — so assert the tally by hand here.
    println!(
        "  {:<44} {:>8} calls  {:>8} Ok  {:>8} Err  {:>3} PANIC",
        "0 / u64::MAX into everything",
        t.calls,
        t.ok,
        t.err,
        t.panics.len()
    );
    assert!(t.panics.is_empty(), "panics: {:?}", t.panics);
    assert_eq!(t.ok, 0, "no all-extreme input should be in-domain");
    assert_eq!(t.calls, t.err, "every extreme input must return an error");
}

/// The exact domain edges, with the exact error variant each must produce.
///
/// This is the part the grid cannot express: not "it did not panic" but "it
/// refused, and refused with the documented discriminant", which is what T07's
/// `From<LmsrError>` mapping depends on.
#[test]
fn the_domain_edges_return_the_documented_errors() {
    assert_eq!(validate_q(MAX_Q), Ok(()));
    assert_eq!(validate_q(MAX_Q + 1), Err(LmsrError::QOutOfRange));
    assert_eq!(validate_b(B_MIN), Ok(()));
    assert_eq!(validate_b(B_MIN - 1), Err(LmsrError::BOutOfRange));
    assert_eq!(validate_b(B_MAX), Ok(()));
    assert_eq!(validate_b(B_MAX + 1), Err(LmsrError::BOutOfRange));

    // q at the edge, from both sides, at both b endpoints.
    for b in [B_MIN, B_MAX] {
        assert!(cost(MAX_Q, MAX_Q, b).is_ok());
        assert!(cost(MAX_Q - 1, MAX_Q, b).is_ok());
        assert_eq!(cost(MAX_Q + 1, 0, b), Err(LmsrError::QOutOfRange));
        assert_eq!(cost(0, MAX_Q + 1, b), Err(LmsrError::QOutOfRange));

        // A buy landing exactly on MAX_Q is legal; one base unit past it is not.
        assert!(buy_cost(0, 0, b, Outcome::Yes, MAX_Q).is_ok());
        assert_eq!(
            buy_cost(1, 0, b, Outcome::Yes, MAX_Q),
            Err(LmsrError::QOutOfRange)
        );
        assert_eq!(
            buy_cost(0, 0, b, Outcome::Yes, MAX_Q + 1),
            Err(LmsrError::QOutOfRange)
        );

        // Selling exactly the supply empties the side; one more is refused.
        assert!(sell_return(MAX_Q, 0, b, Outcome::Yes, MAX_Q).is_ok());
        assert_eq!(
            sell_return(MAX_Q - 1, 0, b, Outcome::Yes, MAX_Q),
            Err(LmsrError::InsufficientShares)
        );
        assert_eq!(
            sell_return(0, 0, b, Outcome::Yes, 1),
            Err(LmsrError::InsufficientShares)
        );
    }

    // b just outside, with an otherwise perfectly ordinary state.
    for b in [0, 1, B_MIN - 1, B_MAX + 1, u64::MAX] {
        assert_eq!(cost(0, 0, b), Err(LmsrError::BOutOfRange), "b = {b}");
        assert_eq!(max_loss_bound(b), Err(LmsrError::BOutOfRange), "b = {b}");
        assert_eq!(
            price_yes(UNIT, UNIT, b),
            Err(LmsrError::BOutOfRange),
            "b = {b}"
        );
    }
}

/// Maximum skew at minimum `b`: `q_yes = MAX_Q`, `q_no = 0`, `b = B_MIN`.
///
/// `(q_no − q_yes)/b = −1e8`, roughly 140,000× past where a naive
/// `exp(q/b)` would have overflowed. Every value here is a mathematical limit,
/// so every assertion is exact — no tolerance.
#[test]
fn the_harshest_legal_input() {
    let (q, b) = (MAX_Q, B_MIN);

    // exp(-1e8) underflows every representable format; the limit is exact.
    assert_eq!(cost(q, 0, b), Ok(q));
    assert_eq!(cost(0, q, b), Ok(q));
    assert_eq!(price_yes(q, 0, b), Ok(UNIT));
    assert_eq!(price_no(q, 0, b), Ok(0));
    assert_eq!(price_yes(0, q, b), Ok(0));
    assert_eq!(price_no(0, q, b), Ok(UNIT));

    // The worthless side is free, and the crate says so rather than erroring.
    assert_eq!(buy_cost(q, 0, b, Outcome::No, UNIT), Ok(0));
    assert_eq!(sell_return(q, 0, b, Outcome::Yes, UNIT), Ok(UNIT));

    // One USDC buys almost the entire cap on the worthless side. The exact
    // figure is the one `reference/README.md` §2 quotes, so it is asserted
    // exactly rather than as "a big number".
    assert_eq!(
        shares_for_cost(q, 0, b, Outcome::No, UNIT),
        Ok(999_999_977_478_315)
    );

    // And `shares_for_cost` is genuinely unclamped: `edge-00897` — 100,000,000
    // USDC on the worthless side at `b = B_MAX` — returns 10% *past* `MAX_Q`.
    // The crate must return the mathematical answer; rejecting it is T07's job.
    //
    // The exact answer is `1.1e15 − 3.7e-32` (the `−e^-100` correction), so the
    // oracle floors to `…999` while Q64.64 — which cannot represent `e^-100` —
    // lands on `1.1e15` exactly. That is one of the 34 `shares_for_cost`
    // disagreements the conformance suite accounts for at skew 1000, hence the
    // one base unit of latitude here.
    let over = shares_for_cost(MAX_Q, 0, B_MAX, Outcome::No, 100_000_000_000_000)
        .expect("unclamped answer, not an error");
    assert!(
        (1_099_999_999_999_999..=1_100_000_000_000_000).contains(&over),
        "edge-00897 expected 1.1e15 (±1), got {over}"
    );
    assert!(over > MAX_Q, "shares_for_cost silently clamped to MAX_Q");
    assert_eq!(
        buy_cost(MAX_Q, 0, B_MAX, Outcome::No, over),
        Err(LmsrError::QOutOfRange),
        "buy_cost must refuse the oversized answer"
    );

    // Both extremes of b, both directions of skew, all six functions.
    for b in [B_MIN, B_MAX] {
        for (qy, qn) in [(MAX_Q, 0), (0, MAX_Q), (MAX_Q, MAX_Q), (MAX_Q, MAX_Q - 1)] {
            assert!(cost(qy, qn, b).is_ok());
            let py = price_yes(qy, qn, b).unwrap();
            assert!(py <= UNIT);
            assert_eq!(py + price_no(qy, qn, b).unwrap(), UNIT);
            for o in OUTCOMES {
                let room = MAX_Q - o.select(qy, qn);
                assert!(buy_cost(qy, qn, b, o, room).is_ok());
                assert!(sell_return(qy, qn, b, o, o.select(qy, qn)).is_ok());
                assert!(shares_for_cost(qy, qn, b, o, MAX_Q).is_ok());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Pseudorandom fuzz
// ---------------------------------------------------------------------------

/// xorshift64*, so the run is deterministic and reproducible from the seed
/// alone. No `rand` dependency reaches the crate.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// A value biased towards the interesting places: sometimes a raw `u64`,
    /// sometimes an in-domain value, sometimes a value one step off a boundary.
    fn adversarial(&mut self, hi: u64) -> u64 {
        let r = self.next();
        match r % 8 {
            0 => r,
            1 => r >> (self.next() % 64),
            2 => hi.wrapping_add(self.next() % 5).wrapping_sub(2),
            3 => self.next() % 5,
            4 => (1u64 << 63).wrapping_add(self.next() % 5).wrapping_sub(2),
            _ => r % hi.saturating_add(1).max(1),
        }
    }
}

#[test]
fn pseudorandom_fuzz_never_panics() {
    const ITERATIONS: u64 = 200_000;
    let mut rng = Rng(0x5EED_2026_0907_0004);
    let mut t = Tally::default();

    for _ in 0..ITERATIONS {
        let q_yes = rng.adversarial(MAX_Q);
        let q_no = rng.adversarial(MAX_Q);
        let b = rng.adversarial(B_MAX);
        let n = rng.adversarial(MAX_Q);
        let o = if rng.next() & 1 == 0 {
            Outcome::Yes
        } else {
            Outcome::No
        };
        let label = format!("q_yes={q_yes} q_no={q_no} b={b} o={o:?} n={n}");

        t.record(&label, catch(move || cost(q_yes, q_no, b)));
        t.record(&label, catch(move || price_yes(q_yes, q_no, b)));
        t.record(&label, catch(move || price_no(q_yes, q_no, b)));
        t.record(&label, catch(move || buy_cost(q_yes, q_no, b, o, n)));
        t.record(&label, catch(move || sell_return(q_yes, q_no, b, o, n)));
        t.record(&label, catch(move || shares_for_cost(q_yes, q_no, b, o, n)));
        t.record(&label, catch(move || max_loss_bound(b)));

        // Whatever came back, the invariants that do not depend on the domain
        // must still hold.
        if let (Ok(Ok(py)), Ok(Ok(pn))) = (
            catch(move || price_yes(q_yes, q_no, b)),
            catch(move || price_no(q_yes, q_no, b)),
        ) {
            assert!(py <= UNIT, "{label}: price_yes {py}");
            assert_eq!(py + pn, UNIT, "{label}");
        }
    }

    t.finish("pseudorandom fuzz (200k cases x 7 functions)");
}

// ---------------------------------------------------------------------------
// The fixed-point layer
// ---------------------------------------------------------------------------

/// `Fixed` is `pub`, so it is part of the same no-panic contract. Fed the raw
/// representation extremes directly, bypassing every LMSR-level validator.
#[test]
fn the_fixed_layer_never_panics_on_extreme_raw_values() {
    let mut raws = vec![
        0i128,
        1,
        -1,
        i128::MIN,
        i128::MAX,
        i128::MIN + 1,
        i128::MAX - 1,
        1i128 << 64,
        -(1i128 << 64),
        45i128 << 64,
        -45i128 << 64,
        (45i128 << 64) - 1,
        (-45i128 << 64) + 1,
        i128::from(u64::MAX),
    ];
    let mut rng = Rng(0xC0FF_EE00_1234_5678);
    for _ in 0..20_000 {
        let hi = i128::from(rng.next());
        let lo = i128::from(rng.next());
        raws.push((hi << 64) | lo);
    }

    let mut calls = 0u64;
    let mut panics = Vec::new();
    for &r in &raws {
        for (what, res) in [
            ("exp", catch(move || Fixed::from_raw(r).exp()).map(|v| v.map(|f| f.to_raw()))),
            ("ln", catch(move || Fixed::from_raw(r).ln()).map(|v| v.map(|f| f.to_raw()))),
            ("expm1", catch(move || Fixed::from_raw(r).expm1()).map(|v| v.map(|f| f.to_raw()))),
        ] {
            calls += 1;
            if let Err(m) = res {
                panics.push(format!("{what}(raw {r}): {m}"));
            }
        }

        // Conversions and checked arithmetic, at the same extremes.
        for &s in &[0i128, 1, -1, i128::MIN, i128::MAX, 1i128 << 64] {
            calls += 5;
            for (what, res) in [
                ("checked_add", catch(move || Fixed::from_raw(r).checked_add(Fixed::from_raw(s)))),
                ("checked_sub", catch(move || Fixed::from_raw(r).checked_sub(Fixed::from_raw(s)))),
                ("checked_mul", catch(move || Fixed::from_raw(r).checked_mul(Fixed::from_raw(s)))),
                (
                    "checked_mul_nearest",
                    catch(move || Fixed::from_raw(r).checked_mul_nearest(Fixed::from_raw(s))),
                ),
                ("checked_div", catch(move || Fixed::from_raw(r).checked_div(Fixed::from_raw(s)))),
            ] {
                if let Err(m) = res {
                    panics.push(format!("{what}(raw {r}, raw {s}): {m}"));
                }
            }
        }

        calls += 4;
        for (what, res) in [
            ("to_int_floor", catch(move || Fixed::from_raw(r).to_int_floor()).map(|_| ())),
            ("to_int_ceil", catch(move || Fixed::from_raw(r).to_int_ceil()).map(|_| ())),
            (
                "to_base_units_floor",
                catch(move || Fixed::from_raw(r).to_base_units_floor()).map(|_| ()),
            ),
            (
                "to_base_units_ceil",
                catch(move || Fixed::from_raw(r).to_base_units_ceil()).map(|_| ()),
            ),
        ] {
            if let Err(m) = res {
                panics.push(format!("{what}(raw {r}): {m}"));
            }
        }
    }

    // `from_ratio` with a zero denominator, and with both extremes.
    for &num in &[0i128, 1, -1, i128::MIN, i128::MAX] {
        for &den in &[0i128, 1, -1, i128::MIN, i128::MAX] {
            calls += 1;
            match catch(move || Fixed::from_ratio(num, den)) {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => assert!(
                    matches!(e, FixedError::Overflow | FixedError::DivByZero),
                    "from_ratio({num}, {den}) -> unexpected {e:?}"
                ),
                Err(m) => panics.push(format!("from_ratio({num}, {den}): {m}")),
            }
        }
    }

    println!("  {:<44} {calls:>8} calls  {:>3} PANIC", "fixed layer", panics.len());
    assert!(
        panics.is_empty(),
        "{} panicking input(s); first few:\n  {}",
        panics.len(),
        panics.iter().take(20).cloned().collect::<Vec<_>>().join("\n  ")
    );

    // Documented domain behaviour, exactly.
    assert_eq!(Fixed::ZERO.ln(), Err(FixedError::Domain));
    assert_eq!(Fixed::from_int(-1).ln(), Err(FixedError::Domain));
    assert_eq!(Fixed::MIN.exp(), Ok(Fixed::ZERO));
    assert_eq!(Fixed::MAX.exp(), Err(FixedError::Overflow));
    assert_eq!(Fixed::from_raw(1).checked_div(Fixed::ZERO), None);
}
