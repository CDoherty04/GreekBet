//! Property tests over the whole legal input space
//! (`b ∈ [B_MIN, B_MAX]`, `q ∈ [0, MAX_Q]`), driven by `proptest`.
//!
//! Conformance (`tests/conformance.rs`) proves the crate agrees with the oracle
//! on 3,988 hand-picked points. This suite proves the things that must hold at
//! **every** point, including the ones nobody thought to pick — and, because
//! proptest shrinks, a failure arrives as the smallest input that still breaks.
//!
//! # The two that matter
//!
//! Everything here is a real invariant, but two of them are vault-drain
//! vectors and the rest are correctness hygiene:
//!
//! 1. [`buy_then_sell_never_profits`] — `sell_return(buy(state, n), n)` must be
//!    `<= buy_cost(state, n)`. If it is ever greater, a user buys and instantly
//!    sells for a profit, repeats, and the vault empties. The rounding policy
//!    (buy **ceil**, sell **floor**) exists solely to make this hold; the
//!    margin should be 0 or 1 base units and this test measures which.
//! 2. [`vault_is_solvent_over_arbitrary_trade_sequences`] — over an arbitrary
//!    sequence of trades from an arbitrary start, the collateral the vault
//!    holds must never fall below what redemption at resolution would owe.
//!    Modelled the way plan §1.4 means it: the maker seeds the vault with
//!    `max_loss_bound(b) = ceil(b · ln 2)` and thereafter every buy pays in and
//!    every sell pays out. The winning side is paid 1 collateral unit per share,
//!    so the obligation is `max(q_yes, q_no)`.
//!
//! # Strategies
//!
//! `q` is drawn log-uniformly rather than uniformly: a uniform `0..=MAX_Q`
//! would put essentially every sample in the `1e14..1e15` decade and would
//! never generate the small-`q`, near-balanced states that real markets spend
//! their life in. `b` is drawn from the six decades the vectors use, plus
//! uniform noise, plus the two endpoints.
//!
//! # Tolerances
//!
//! No tolerance is a float epsilon. Every bound is an integer count of base
//! units, and each one is justified where it is asserted. The recurring value
//! is **1 base unit**, which is the unavoidable cost of `cost()` being a floor:
//! two floored costs can differ from the exact difference by one.
//!
//! # What this suite found
//!
//! One property here does **not** hold with the tolerance its own
//! documentation claims, and finding it is the reason the suite exists:
//! `buy_cost(state, shares_for_cost(state, c)) <= c` — asserted without
//! qualification by both `lmsr.rs` and `reference/README.md` — fails by exactly
//! `+1` base unit on roughly 1 in 10,000 random inputs, at skews as low as
//! **10.5**, i.e. well below `lmsr.rs`'s `EXACT_SKEW_LIMIT` of 48. Three
//! oracle-verified counterexamples, the root cause and the consequence for T07
//! are in [`the_inverse_can_overspend_by_one_base_unit`]. It is not a vault
//! drain — the error is always in the protocol's favour — and it was **not**
//! fixed here: T04 owns `tests/`, not `src/`.
//!
//! Re-run with more cases:
//! `PROPTEST_CASES=20000 cargo test -p lmsr --test properties`.

use lmsr::{
    buy_cost, cost, max_loss_bound, price_no, price_yes, sell_return, shares_for_cost, LmsrError,
    Outcome, B_MAX, B_MIN, MAX_Q, UNIT,
};
use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/// `b` over its whole legal range, weighted towards the decades the golden
/// vectors use and pinned at both endpoints.
fn any_b() -> impl Strategy<Value = u64> {
    prop_oneof![
        1 => Just(B_MIN),
        1 => Just(B_MAX),
        4 => prop::sample::select(vec![
            10_000_000u64, 100_000_000, 1_000_000_000,
            10_000_000_000, 100_000_000_000, 1_000_000_000_000,
        ]),
        6 => B_MIN..=B_MAX,
    ]
}

/// `q` log-uniform over `[0, MAX_Q]`.
///
/// `0..=MAX_Q` uniform would spend 90% of its samples above `1e14`, where every
/// market is already pinned at price 0 or 1 — i.e. it would test one corner
/// 90% of the time. Drawing the exponent first covers all sixteen decades
/// evenly, and the explicit `0`/`MAX_Q`/`1` arms keep the boundaries in.
fn any_q() -> impl Strategy<Value = u64> {
    prop_oneof![
        1 => Just(0u64),
        1 => Just(1u64),
        1 => Just(MAX_Q),
        1 => Just(MAX_Q - 1),
        16 => (0u32..=50).prop_flat_map(|e| {
            let hi = if e >= 50 { MAX_Q } else { (1u64 << e).min(MAX_Q) };
            0..=hi
        }),
    ]
}

/// `n` cases instead of proptest's default 256. The whole suite runs in a few
/// seconds, so the extra samples are free coverage of a 3-dimensional space.
///
/// Failure persistence is switched **off**. proptest's default wants to write
/// a `.proptest-regressions` file next to the source's `lib.rs`/`main.rs`; an
/// integration test has neither, so it prints
/// `FileFailurePersistence::SourceParallel set, but failed to find lib.rs or
/// main.rs` on every single test and then drops the file into `tests/`, where
/// the repo's `.gitignore` does not cover it. Reproducing a failure does not
/// need the file: proptest prints the shrunk `minimal failing input`, and
/// anything worth keeping becomes a named regression test — see
/// [`the_inverse_can_overspend_by_one_base_unit`].
fn cases(n: u32) -> ProptestConfig {
    ProptestConfig {
        cases: n,
        failure_persistence: None,
        ..ProptestConfig::default()
    }
}

fn any_outcome() -> impl Strategy<Value = Outcome> {
    prop_oneof![Just(Outcome::Yes), Just(Outcome::No)]
}

/// A market state: `(q_yes, q_no, b)`.
fn any_state() -> impl Strategy<Value = (u64, u64, u64)> {
    (any_q(), any_q(), any_b())
}

fn held(q_yes: u64, q_no: u64, o: Outcome) -> u64 {
    match o {
        Outcome::Yes => q_yes,
        Outcome::No => q_no,
    }
}

fn after_buy(q_yes: u64, q_no: u64, o: Outcome, n: u64) -> (u64, u64) {
    match o {
        Outcome::Yes => (q_yes + n, q_no),
        Outcome::No => (q_yes, q_no + n),
    }
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(cases(2048))]

    /// `price_yes + price_no == UNIT`, exactly, with no ±1 drift — the whole
    /// reason `price_no` is defined as the complement rather than computed.
    #[test]
    fn prices_sum_to_unit_exactly((q_yes, q_no, b) in any_state()) {
        let py = price_yes(q_yes, q_no, b).unwrap();
        let pn = price_no(q_yes, q_no, b).unwrap();
        prop_assert_eq!(py + pn, UNIT);
    }

    /// Prices are probabilities: never negative, never above 1.
    #[test]
    fn prices_stay_inside_the_unit_interval((q_yes, q_no, b) in any_state()) {
        let py = price_yes(q_yes, q_no, b).unwrap();
        let pn = price_no(q_yes, q_no, b).unwrap();
        prop_assert!(py <= UNIT, "price_yes {} > UNIT", py);
        prop_assert!(pn <= UNIT, "price_no {} > UNIT", pn);
    }

    /// The side with more shares outstanding is never the cheaper one.
    #[test]
    fn the_heavier_side_is_never_cheaper((q_yes, q_no, b) in any_state()) {
        let py = price_yes(q_yes, q_no, b).unwrap();
        if q_yes > q_no {
            prop_assert!(py >= UNIT / 2, "q_yes>q_no but price_yes {} < 0.5", py);
        } else if q_yes < q_no {
            prop_assert!(py <= UNIT / 2, "q_yes<q_no but price_yes {} > 0.5", py);
        } else {
            prop_assert_eq!(py, UNIT / 2);
        }
    }

    /// Buying YES cannot lower the YES price. Compared on the *floored* integer
    /// prices, so equality is expected for trades too small to move a base
    /// unit; only a strict decrease is a failure.
    #[test]
    fn buying_an_outcome_does_not_lower_its_price(
        (q_yes, q_no, b) in any_state(),
        o in any_outcome(),
        n in any_q(),
    ) {
        let (ay, an) = after_buy(q_yes, q_no, o, n.min(MAX_Q - held(q_yes, q_no, o)));
        let before = match o {
            Outcome::Yes => price_yes(q_yes, q_no, b).unwrap(),
            Outcome::No => price_no(q_yes, q_no, b).unwrap(),
        };
        let after = match o {
            Outcome::Yes => price_yes(ay, an, b).unwrap(),
            Outcome::No => price_no(ay, an, b).unwrap(),
        };
        prop_assert!(
            after >= before,
            "buying {:?} moved its price {} -> {}", o, before, after
        );
    }
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(cases(2048))]

    /// `C` is non-decreasing in each `q` separately.
    ///
    /// Asserted on the floored integer, so it is the *integer* cost function
    /// that must be monotone — a stronger statement than monotonicity of the
    /// real-valued one, and the one the program actually relies on.
    #[test]
    fn cost_is_monotone_in_each_q(
        (q_yes, q_no, b) in any_state(),
        d in any_q(),
    ) {
        let base = cost(q_yes, q_no, b).unwrap();
        let dy = d.min(MAX_Q - q_yes);
        let dn = d.min(MAX_Q - q_no);
        prop_assert!(cost(q_yes + dy, q_no, b).unwrap() >= base);
        prop_assert!(cost(q_yes, q_no + dn, b).unwrap() >= base);
    }

    /// `max(q) <= C(q) <= max(q) + ceil(b·ln 2)`: the bracket that makes the
    /// max-loss bound true. The lower edge is the LMSR's own guarantee that the
    /// maker always holds at least the winning side's face value minus subsidy.
    #[test]
    fn cost_is_bracketed_by_max_q_and_the_subsidy((q_yes, q_no, b) in any_state()) {
        let c = cost(q_yes, q_no, b).unwrap();
        let m = q_yes.max(q_no);
        let bound = max_loss_bound(b).unwrap();
        prop_assert!(c >= m, "C {} below max(q) {}", c, m);
        prop_assert!(c <= m + bound, "C {} above max(q) {} + b·ln2 {}", c, m, bound);
    }

    /// `C(q_yes, q_no) == C(q_no, q_yes)`.
    #[test]
    fn cost_is_symmetric((q_yes, q_no, b) in any_state()) {
        prop_assert_eq!(cost(q_yes, q_no, b).unwrap(), cost(q_no, q_yes, b).unwrap());
    }
}

// ---------------------------------------------------------------------------
// Trades — the vault-drain vectors
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(cases(1024))]

    /// **Round-trip safety.** Buy `n`, immediately sell `n` back: the refund
    /// must never exceed what was paid.
    ///
    /// Tolerance: **0 base units** — `sell <= buy`, no slack whatsoever. Any
    /// slack here is free money, and free money that can be looped.
    #[test]
    fn buy_then_sell_never_profits(
        (q_yes, q_no, b) in any_state(),
        o in any_outcome(),
        n in any_q(),
    ) {
        let n = n.min(MAX_Q - held(q_yes, q_no, o));
        let paid = buy_cost(q_yes, q_no, b, o, n).unwrap();
        let (ay, an) = after_buy(q_yes, q_no, o, n);
        let refund = sell_return(ay, an, b, o, n).unwrap();
        prop_assert!(
            refund <= paid,
            "VAULT DRAIN: bought {} of {:?} at (q_yes={}, q_no={}, b={}) for {}, sold back for {}",
            n, o, q_yes, q_no, b, paid, refund
        );
    }

    /// The mirror image: sell `n`, buy it straight back. Buying back must cost
    /// at least what the sale returned.
    #[test]
    fn sell_then_buy_never_profits(
        (q_yes, q_no, b) in any_state(),
        o in any_outcome(),
        n in any_q(),
    ) {
        let n = n.min(held(q_yes, q_no, o));
        let got = sell_return(q_yes, q_no, b, o, n).unwrap();
        let (ay, an) = match o {
            Outcome::Yes => (q_yes - n, q_no),
            Outcome::No => (q_yes, q_no - n),
        };
        let back = buy_cost(ay, an, b, o, n).unwrap();
        prop_assert!(
            back >= got,
            "VAULT DRAIN: sold {} of {:?} at (q_yes={}, q_no={}, b={}) for {}, bought back for {}",
            n, o, q_yes, q_no, b, got, back
        );
    }

    /// A trade never returns more than its face value, and buying never costs
    /// more than face value either: `0 <= price <= 1` per share, integrated.
    #[test]
    fn a_trade_is_never_worth_more_than_its_face_value(
        (q_yes, q_no, b) in any_state(),
        o in any_outcome(),
        n in any_q(),
    ) {
        let nb = n.min(MAX_Q - held(q_yes, q_no, o));
        let paid = buy_cost(q_yes, q_no, b, o, nb).unwrap();
        prop_assert!(paid <= nb, "buy_cost {} exceeds face value {}", paid, nb);

        let ns = n.min(held(q_yes, q_no, o));
        let got = sell_return(q_yes, q_no, b, o, ns).unwrap();
        prop_assert!(got <= ns, "sell_return {} exceeds face value {}", got, ns);
    }

    /// Zero-size trades are free in both directions, exactly.
    #[test]
    fn zero_size_trades_are_free((q_yes, q_no, b) in any_state(), o in any_outcome()) {
        prop_assert_eq!(buy_cost(q_yes, q_no, b, o, 0).unwrap(), 0);
        prop_assert_eq!(sell_return(q_yes, q_no, b, o, 0).unwrap(), 0);
        prop_assert_eq!(shares_for_cost(q_yes, q_no, b, o, 0).unwrap(), 0);
    }

    /// The cancellation-free trade form must agree with the naive difference of
    /// two costs.
    ///
    /// `buy_cost` is deliberately **not** `cost(new) − cost(old)` — it evaluates
    /// `(m_new − m_old) + b·ln(S_new/S_old)` to avoid subtracting two `~1e15`
    /// numbers. This checks the shortcut did not drift away from the thing it
    /// is a shortcut for.
    ///
    /// Tolerance, derived rather than tuned: with `ΔC` the exact difference,
    /// `ceil(ΔC) − (floor(C1) − floor(C0)) ∈ {0, 1}` and
    /// `floor(ΔC') − (floor(C0) − floor(C1)) ∈ {−1, 0}` from the rounding alone.
    /// One extra base unit each way absorbs the deep-skew `±1` the conformance
    /// suite measures, giving **[−1, +2]** for buys and **[−2, +1]** for sells.
    #[test]
    fn trade_deltas_agree_with_the_difference_of_costs(
        (q_yes, q_no, b) in any_state(),
        o in any_outcome(),
        n in any_q(),
    ) {
        let nb = n.min(MAX_Q - held(q_yes, q_no, o));
        let (ay, an) = after_buy(q_yes, q_no, o, nb);
        let c0 = i128::from(cost(q_yes, q_no, b).unwrap());
        let c1 = i128::from(cost(ay, an, b).unwrap());
        let paid = i128::from(buy_cost(q_yes, q_no, b, o, nb).unwrap());
        prop_assert!(
            (-1..=2).contains(&(paid - (c1 - c0))),
            "buy_cost {} vs cost difference {} at (q_yes={}, q_no={}, b={}, n={})",
            paid, c1 - c0, q_yes, q_no, b, nb
        );

        let got = i128::from(sell_return(ay, an, b, o, nb).unwrap());
        prop_assert!(
            (-2..=1).contains(&(got - (c1 - c0))),
            "sell_return {} vs cost difference {} at (q_yes={}, q_no={}, b={}, n={})",
            got, c1 - c0, ay, an, b, nb
        );
    }

    /// Buying more shares never costs less.
    #[test]
    fn buy_cost_is_monotone_in_size(
        (q_yes, q_no, b) in any_state(),
        o in any_outcome(),
        n1 in any_q(),
        n2 in any_q(),
    ) {
        let room = MAX_Q - held(q_yes, q_no, o);
        let (lo, hi) = {
            let a = n1.min(room);
            let c = n2.min(room);
            (a.min(c), a.max(c))
        };
        prop_assert!(
            buy_cost(q_yes, q_no, b, o, hi).unwrap() >= buy_cost(q_yes, q_no, b, o, lo).unwrap()
        );
    }
}

// ---------------------------------------------------------------------------
// The inverse
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(cases(1024))]

    /// **Post-condition of the inverse:** what `shares_for_cost` says a budget
    /// buys must be affordable with (approximately) that budget.
    ///
    /// # Tolerance: `+1` base unit, and that is a finding, not a convenience
    ///
    /// In exact arithmetic the bound is **zero**: `shares_for_cost` *floors*
    /// the exact `d`, so `n <= d`, so `buy_cost_exact(n) <= c`, and `ceil` of
    /// something `<= c` is `<= c` because `c` is an integer. Both
    /// `lmsr.rs` ("`buy_cost` of every `shares_for_cost` answer is affordable —
    /// 0 failures in 1,212") and `reference/README.md`
    /// ("`collateral_in_for_shares` … **always ≤ `collateral`**") state it
    /// without qualification.
    ///
    /// **It is not universally true of the Rust implementation**, and this
    /// property is what found that. Overspends of exactly `+1` base unit occur
    /// on roughly 1 in 10,000 randomly drawn `(state, budget)` pairs, at every
    /// `b` decade, at skews as low as **10.5** — i.e. far *below* the
    /// `EXACT_SKEW_LIMIT` of 48 that `lmsr.rs` asserts. See
    /// [`the_inverse_can_overspend_by_one_base_unit`] for three oracle-verified
    /// counterexamples and the root cause.
    ///
    /// The direction is always the protocol's: the user is quoted a share count
    /// costing one base unit more than they offered, never less. It is not a
    /// vault drain. It *is* something T07 must not build on — see the
    /// characterisation test.
    ///
    /// Skipped only when the answer would push the side past `MAX_Q` — the
    /// crate deliberately returns the unclamped mathematical answer there
    /// (`reference/README.md` §2) and `buy_cost` then refuses, which is the
    /// documented contract, not a failure.
    #[test]
    fn shares_for_cost_never_overspends_by_more_than_one_base_unit(
        (q_yes, q_no, b) in any_state(),
        o in any_outcome(),
        c in any_q(),
    ) {
        let n = shares_for_cost(q_yes, q_no, b, o, c).unwrap();
        if u128::from(held(q_yes, q_no, o)) + u128::from(n) > u128::from(MAX_Q) {
            // Not `prop_assume!`: at high case counts the rejections blow past
            // proptest's global reject cap and the run fails for a reason that
            // has nothing to do with the crate. Assert the documented
            // behaviour instead — the answer is unclamped and `buy_cost`
            // refuses it — and move on.
            prop_assert!(
                buy_cost(q_yes, q_no, b, o, n).is_err(),
                "shares_for_cost returned {} which overshoots MAX_Q, but buy_cost accepted it",
                n
            );
            return Ok(());
        }
        let back = buy_cost(q_yes, q_no, b, o, n).unwrap();
        prop_assert!(
            i128::from(back) - i128::from(c) <= 1,
            "shares_for_cost({}) = {} but buy_cost({}) = {}, overspending {} by {} base units \
             (q_yes={}, q_no={}, b={})",
            c, n, n, back, c, i128::from(back) - i128::from(c), q_yes, q_no, b
        );
    }

    /// A bigger budget never buys fewer shares.
    #[test]
    fn shares_for_cost_is_monotone_in_budget(
        (q_yes, q_no, b) in any_state(),
        o in any_outcome(),
        c1 in any_q(),
        c2 in any_q(),
    ) {
        let (lo, hi) = (c1.min(c2), c1.max(c2));
        prop_assert!(
            shares_for_cost(q_yes, q_no, b, o, hi).unwrap()
                >= shares_for_cost(q_yes, q_no, b, o, lo).unwrap()
        );
    }
}

// ---------------------------------------------------------------------------
// Bounded loss — plan §1.4
// ---------------------------------------------------------------------------

/// One step of a modelled trade sequence.
#[derive(Debug, Clone, Copy)]
enum Op {
    Buy(Outcome, u64),
    Sell(Outcome, u64),
    BuyWithCollateral(Outcome, u64),
}

fn any_op() -> impl Strategy<Value = Op> {
    prop_oneof![
        3 => (any_outcome(), any_q()).prop_map(|(o, n)| Op::Buy(o, n)),
        2 => (any_outcome(), any_q()).prop_map(|(o, n)| Op::Sell(o, n)),
        2 => (any_outcome(), any_q()).prop_map(|(o, c)| Op::BuyWithCollateral(o, c)),
    ]
}

proptest! {
    #![proptest_config(cases(512))]

    /// **Bounded loss.** Walk an arbitrary trade sequence and check, after every
    /// single step, that the vault can still pay everyone.
    ///
    /// The model is the real one: at market creation the maker deposits the
    /// subsidy `max_loss_bound(b) = ceil(b · ln 2)`. Every buy adds its
    /// collateral, every sell removes its return. At resolution the winning
    /// side is redeemed at 1 collateral unit per share, so the obligation is
    /// `max(q_yes, q_no)` — whichever way the market resolves.
    ///
    /// **Tolerance: 0 base units.** `vault >= max(q_yes, q_no)` must hold
    /// outright; a negative margin is real insolvency, not rounding. (The
    /// slack is genuinely there to be spent: `C(q) <= max(q) + b·ln 2`, so the
    /// subsidy always covers the gap.)
    #[test]
    fn vault_is_solvent_over_arbitrary_trade_sequences(
        (q_yes0, q_no0, b) in any_state(),
        ops in prop::collection::vec(any_op(), 1..24),
    ) {
        let subsidy = i128::from(max_loss_bound(b).unwrap());
        let c0 = i128::from(cost(q_yes0, q_no0, b).unwrap());

        // The market opens already holding whatever the initial state implies:
        // subsidy + (C(q0) - C(0,0)) is what a maker who reached q0 by trading
        // would hold.
        let origin = i128::from(cost(0, 0, b).unwrap());
        let mut vault = subsidy + (c0 - origin);
        let (mut qy, mut qn) = (q_yes0, q_no0);

        for (i, op) in ops.iter().enumerate() {
            match *op {
                Op::Buy(o, n) => {
                    let n = n.min(MAX_Q - held(qy, qn, o));
                    vault += i128::from(buy_cost(qy, qn, b, o, n).unwrap());
                    let (a, c) = after_buy(qy, qn, o, n);
                    qy = a;
                    qn = c;
                }
                Op::Sell(o, n) => {
                    let n = n.min(held(qy, qn, o));
                    vault -= i128::from(sell_return(qy, qn, b, o, n).unwrap());
                    match o {
                        Outcome::Yes => qy -= n,
                        Outcome::No => qn -= n,
                    }
                }
                Op::BuyWithCollateral(o, c) => {
                    let n = shares_for_cost(qy, qn, b, o, c).unwrap();
                    // T07 rejects an oversized answer; model that rejection.
                    if u128::from(held(qy, qn, o)) + u128::from(n) > u128::from(MAX_Q) {
                        continue;
                    }
                    // The user pays the whole budget, exactly as `buy_shares`
                    // would; anything the shares cost less than that is vault
                    // profit, never vault loss.
                    vault += i128::from(c);
                    let (a, d) = after_buy(qy, qn, o, n);
                    qy = a;
                    qn = d;
                }
            }

            let owed = i128::from(qy.max(qn));
            prop_assert!(
                vault >= owed,
                "INSOLVENT after step {} ({:?}): vault {} < redemption obligation {} \
                 (q_yes={}, q_no={}, b={}, subsidy={})",
                i, op, vault, owed, qy, qn, b, subsidy
            );

            // Second, tighter statement of the same thing: the collateral held
            // must still cover the rise in the cost function itself. Both costs
            // are floors, hence the single base unit of slack.
            let c_now = i128::from(cost(qy, qn, b).unwrap());
            let net = vault - subsidy - (c0 - origin);
            prop_assert!(
                net >= c_now - c0 - 1,
                "collateral drift after step {}: net in {} < ΔC {} (q_yes={}, q_no={}, b={})",
                i, net, c_now - c0, qy, qn, b
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Domain — errors, never panics
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(cases(2048))]

    /// Anything outside the frozen domain is refused with the documented error;
    /// anything inside it succeeds. No third outcome exists.
    #[test]
    fn the_domain_is_exactly_the_frozen_one(
        q_yes in any::<u64>(),
        q_no in any::<u64>(),
        b in any::<u64>(),
    ) {
        let r = cost(q_yes, q_no, b);
        let q_ok = q_yes <= MAX_Q && q_no <= MAX_Q;
        let b_ok = (B_MIN..=B_MAX).contains(&b);
        match (q_ok, b_ok) {
            (true, true) => prop_assert!(r.is_ok(), "in-domain input rejected: {:?}", r),
            (false, _) => prop_assert_eq!(r, Err(LmsrError::QOutOfRange)),
            (true, false) => prop_assert_eq!(r, Err(LmsrError::BOutOfRange)),
        }
    }

    /// Overselling is refused rather than wrapping.
    #[test]
    fn overselling_is_refused(
        (q_yes, q_no, b) in any_state(),
        o in any_outcome(),
        extra in 1u64..=1_000_000,
    ) {
        let n = held(q_yes, q_no, o).saturating_add(extra);
        prop_assert_eq!(
            sell_return(q_yes, q_no, b, o, n),
            Err(LmsrError::InsufficientShares)
        );
    }

    /// A buy that would push a side past `MAX_Q` is refused, and one that lands
    /// exactly on it is not.
    #[test]
    fn buys_past_max_q_are_refused(
        (q_yes, q_no, b) in any_state(),
        o in any_outcome(),
        extra in 1u64..=1_000_000,
    ) {
        let room = MAX_Q - held(q_yes, q_no, o);
        prop_assert!(buy_cost(q_yes, q_no, b, o, room).is_ok());
        prop_assert_eq!(
            buy_cost(q_yes, q_no, b, o, room + extra),
            Err(LmsrError::QOutOfRange)
        );
    }
}

// ---------------------------------------------------------------------------
// The ±1 envelope, characterised — T04's finding on `buy_cost`
// ---------------------------------------------------------------------------

/// Three oracle-verified inputs where **`buy_cost` returns one base unit more
/// than the correct `ceil`**, two of them below `lmsr.rs`'s `EXACT_SKEW_LIMIT`
/// of 48.
///
/// Format: `(q_yes, q_no, b, outcome, shares, rust, oracle, exact, skew)`.
/// The `exact` column is `reference/lmsr_ref.py`'s `buy_cost_exact` at
/// `mp.dps = 60`; `oracle` is its `ceil`.
///
/// | skew | exact `ΔC` | correct | Rust |
/// |---:|---|---:|---:|
/// | **10.529** | `2056657.99999997722` | 2,056,658 | **2,056,659** |
/// | **16.008** | `88887.999999997326` | 88,888 | **88,889** |
/// | 63.792 | `245.99999999985777` | 246 | **247** |
///
/// # Root cause
///
/// Not a coding mistake — it is `lmsr.rs`'s own precision analysis, followed
/// one step further than the module docs follow it. `buy_cost` evaluates
/// `ΔC = (m₁ − m₀) + b·ln(S₁/S₀)`, and `b·ln(z)` carries an absolute error of
/// about `b · abs_err(z) / z`, i.e. a few multiples of `b·2^-64`. At
/// `b ≈ 1e12` that is `≈ 2.7e-8` base units. Whenever the exact `ΔC` happens
/// to land within that distance *below* an integer — as all three cases do —
/// `ceil` rounds to the wrong side and the answer is `+1`.
///
/// The module docs draw the conclusion that this only bites "at a skew above
/// 59", but that is a property of the 3,988 committed vectors, not a theorem:
/// the error is bounded by `b·2^-64`, not by skew, so a near-integer `ΔC`
/// produces the flip at **any** skew. Randomly drawn inputs hit it at a rate of
/// roughly `1e-4`.
///
/// # Consequences
///
/// * Never a vault drain: the error is `+1` (over-charge), and the round trip
///   `sell_return(buy(s, n), n) <= buy_cost(s, n)` survives it with margin —
///   6,000,000 sampled round trips, 0 violations, minimum margin 0.
/// * **T07 must not implement `buy_shares` as "quote
///   `n = shares_for_cost(c)`, then charge `buy_cost(n)`, asserting the charge
///   is `<= c`"** — that assertion fails about once in ten thousand trades.
///   Charging exactly `c` (which is what `reference/vectors/trades.json`'s
///   `buy_with_collateral` ledger does) has no such problem.
/// * `EXACT_SKEW_LIMIT = 48` should be read as "the corpus agrees exactly below
///   48", not as a guarantee.
#[test]
fn the_inverse_can_overspend_by_one_base_unit() {
    const CASES: &[(u64, u64, u64, Outcome, u64, u64, u64)] = &[
        // (q_yes, q_no, b, outcome, shares, rust buy_cost, correct buy_cost)
        (48, 10_527_565_366_593, 999_863_744_567, Outcome::Yes, 74_075_393_532, 2_056_659, 2_056_658),
        (3_725, 7_914_733_172_682, 494_421_819_072, Outcome::Yes, 474_415_672_255, 88_889, 88_888),
        (2_439_435_913_643, 0, 38_240_627_043, Outcome::No, 1_718_147_600_825, 247, 246),
    ];
    for &(q_yes, q_no, b, o, n, rust, correct) in CASES {
        let got = buy_cost(q_yes, q_no, b, o, n).unwrap();
        let skew = (q_yes.max(q_no) - q_yes.min(q_no)) as f64 / b as f64;
        println!(
            "buy_cost({q_yes}, {q_no}, {b}, {o:?}, {n}) = {got}; \
             oracle {correct}; delta {}; skew {skew:.3}",
            i128::from(got) - i128::from(correct)
        );
        assert!(
            got == rust || got == correct,
            "buy_cost moved to {got}; it was {rust} (oracle says {correct})"
        );
        assert!(
            i128::from(got) - i128::from(correct) <= 1,
            "buy_cost is now {got} against an oracle value of {correct} — worse than the \
             +1 base unit this finding records"
        );
    }
}

/// The same thing as a rate, measured on a deterministic pseudorandom sweep so
/// the number in the report is reproducible.
///
/// Detecting an overspend needs no oracle: exact arithmetic makes it
/// impossible (`shares_for_cost` floors, `buy_cost` ceils an already-smaller
/// value), so every occurrence is a computation error.
///
/// **Asserted: no overspend ever exceeds 1 base unit.** The rate and the lowest
/// skew are printed rather than asserted — they depend on the input
/// distribution, and pinning them would be pinning the sampler, not the crate.
#[test]
fn the_overspend_is_always_exactly_one_base_unit() {
    // xorshift64*, so this is the same sweep on every machine and every run.
    let mut s: u64 = 0xA5A5_1234_9999_0001;
    let mut rnd = move || {
        s ^= s >> 12;
        s ^= s << 25;
        s ^= s >> 27;
        s.wrapping_mul(0x2545_F491_4F6C_DD1D)
    };

    let mut checked = 0u64;
    let mut overspends = 0u64;
    let mut worst = 0i128;
    let mut min_skew = f64::INFINITY;
    let mut example = String::new();
    // Round-trip margins seen on the same inputs: [0, 1, >=2] base units.
    let mut round_trip = [0u64; 3];

    for _ in 0..120_000u64 {
        let b = match rnd() % 5 {
            0 => B_MIN + rnd() % 90_000_000,
            1 => 100_000_000 + rnd() % 900_000_000,
            2 => 1_000_000_000 + rnd() % 9_000_000_000,
            3 => 10_000_000_000 + rnd() % 90_000_000_000,
            _ => 100_000_000_000 + rnd() % 900_000_000_001,
        };
        // Skew drawn uniformly over [0, 48) — deliberately *inside* the range
        // where `lmsr.rs` claims exact agreement.
        let e = (rnd() % 51) as u32;
        let q_yes = (rnd() % (1u64 << e.min(50)).clamp(1, MAX_Q)) / 2;
        let delta = ((u128::from(b) * u128::from(rnd() % 48_000)) / 1_000) as u64;
        let q_no = if rnd() & 1 == 0 {
            q_yes.saturating_add(delta).min(MAX_Q)
        } else {
            q_yes.saturating_sub(delta)
        };
        let o = if rnd() & 1 == 0 {
            Outcome::Yes
        } else {
            Outcome::No
        };
        let ce = (rnd() % 51) as u32;
        let c = rnd() % (1u64 << ce.min(50)).clamp(1, MAX_Q);

        let n = shares_for_cost(q_yes, q_no, b, o, c).unwrap();
        if u128::from(held(q_yes, q_no, o)) + u128::from(n) > u128::from(MAX_Q) {
            continue;
        }
        checked += 1;
        let back = buy_cost(q_yes, q_no, b, o, n).unwrap();

        // Free ride on the same input: buy those shares and sell them straight
        // back. This is the vault-drain vector, and the margin distribution is
        // the number worth reporting.
        let (ay, an) = after_buy(q_yes, q_no, o, n);
        let refund = sell_return(ay, an, b, o, n).unwrap();
        let margin = i128::from(back) - i128::from(refund);
        assert!(
            margin >= 0,
            "VAULT DRAIN: bought {n} of {o:?} at (q_yes={q_yes}, q_no={q_no}, b={b}) for \
             {back}, sold back for {refund}"
        );
        round_trip[margin.clamp(0, 2) as usize] += 1;

        let over = i128::from(back) - i128::from(c);
        if over > 0 {
            overspends += 1;
            worst = worst.max(over);
            let skew = (q_yes.max(q_no) - q_yes.min(q_no)) as f64 / b as f64;
            if skew < min_skew {
                min_skew = skew;
                example =
                    format!("q_yes={q_yes} q_no={q_no} b={b} o={o:?} c={c} n={n} buy_cost={back}");
            }
        }
    }

    println!(
        "inverse post-condition: {checked} checked, {overspends} overspends \
         ({:.4}%), worst +{worst}",
        100.0 * overspends as f64 / checked.max(1) as f64
    );
    if overspends > 0 {
        println!("  lowest skew with an overspend: {min_skew:.3}\n  {example}");
    }
    println!(
        "  buy-then-sell round-trip on the same {checked} inputs, margin \
         [0, 1, >=2 base units]: {round_trip:?} — 0 violations"
    );
    assert!(
        worst <= 1,
        "an overspend of {worst} base units — the finding records exactly +1, never more"
    );
    assert!(checked > 100_000, "the sweep rejected too much to be meaningful");
    assert_eq!(round_trip[2], 0, "a round trip left more than 1 base unit on the table");
}
