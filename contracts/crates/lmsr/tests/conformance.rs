//! Golden-vector conformance: every committed case in `reference/vectors/`,
//! run through the Rust API and compared to the 60-digit `mpmath` oracle.
//!
//! # The tolerance, and why it is what it is
//!
//! The oracle is independent (derived from the plan's formulas, never ported
//! from Rust) and its integers are stable — T01 re-ran a spread of cases at
//! `dps = 120` and got bit-identical output. So a disagreement is **the Rust
//! side's error**, and the only question is how large an error is admissible.
//!
//! Two regimes, and the suite asserts both separately:
//!
//! | regime | asserted tolerance |
//! |---|---|
//! | `|q_yes − q_no| / b < 48` ([`EXACT_SKEW_LIMIT`]) | **exact integer equality** |
//! | skew `>= 48` | **≤ 1 base unit** (`1e-6` USDC) |
//!
//! The split is not a fudge factor, it is a statement about Q64.64. One ulp is
//! `2^-64 ≈ 5.4e-20`; the minority weight in the log-sum-exp form is `e^-skew`,
//! which drops below half an ulp at `skew ≈ 45` (and, after the pre-scaling in
//! `lmsr::b_small_softplus`, at `45 + ln b`). `mpmath` at 60 digits still
//! carries that weight, so past the cliff the two arithmetics can legitimately
//! land on opposite sides of an integer boundary — one base unit apart, never
//! more. Below the cliff there is nothing to disagree about and the suite
//! demands equality.
//!
//! Both halves are hard failures. A `> 1` base-unit gap, or **any** gap below
//! skew 48, fails the run with the case id, both values and the skew — those
//! would be genuine findings, not tolerance to widen.
//!
//! ## `EXACT_SKEW_LIMIT` describes this corpus, not the function
//!
//! Every one of the 7,135 comparisons below honours the split, and the lowest
//! disagreeing skew across all of them is 59. **That is a fact about the 3,988
//! committed vectors, not a theorem about the implementation.** The real error
//! bound on `b·ln(z)` is `≈ b · 2^-64 · k` — a few times `1e-8` base units at
//! `b = B_MAX` — and it is bounded by `b`, *not* by skew. Whenever the exact
//! answer happens to land that close below an integer, `ceil` flips at **any**
//! skew.
//!
//! `tests/properties.rs` found exactly that outside this corpus:
//! `buy_cost(48, 10527565366593, 999863744567, Yes, 74075393532)` returns
//! `2_056_659` where the exact value is `2056657.99999997722` and the oracle
//! says `2_056_658` — a `+1` disagreement at **skew 10.5**. See
//! `properties::the_inverse_can_overspend_by_one_base_unit`.
//!
//! So this suite asserting exactness below skew 48 is a *regression guard on a
//! fixed corpus*, which is what it is good for. It is not evidence that the
//! implementation is exact below skew 48, and nothing downstream should treat
//! it as such.
//!
//! A trade spans two states; [`Ctx::trade`] evaluates the guard at the more
//! skewed of the pair, since exactness can only be demanded when every state
//! involved is inside the exact range.
//!
//! # What is compared
//!
//! Every numeric output of every case, plus the invariants the oracle asserts
//! about itself, recomputed from Rust's own numbers:
//!
//! * `price_yes + price_no == UNIT` on every priced case;
//! * `buy_cost(shares_for_cost(c)) <= c` on every inverse case;
//! * `loss <= b·ln 2` on every `max_loss` case;
//! * the running vault balance of every `trades.json` sequence, replayed twice
//!   — once locked to the oracle's states, once free-running on Rust's own
//!   `shares_for_cost` answers, which is what exposes *cumulative* drift rather
//!   than per-step error.
//!
//! Run with `cargo test -p lmsr --test conformance -- --nocapture` to see the
//! per-function tables.

mod common;

use common::*;
use lmsr::{
    buy_cost, cost, max_loss_bound, price_no, price_yes, sell_return, shares_for_cost, Outcome,
    MAX_Q, UNIT,
};

// ---------------------------------------------------------------------------
// Measured envelope — the numbers this suite is allowed to observe
// ---------------------------------------------------------------------------

/// Total comparisons made across all four vector files.
///
/// Pinned so that a vector file silently losing cases (or a `match` arm quietly
/// skipping a `type`) fails instead of passing with less coverage.
const TOTAL_COMPARISONS: u64 = 7_135;

/// Total disagreements across all four files, **measured**. Every one is `±1`
/// base unit and every one is at skew `>= 59`; see the module docs. Pinned so a
/// regression that *adds* disagreements fails even though each individual one
/// is inside tolerance.
///
/// Per function: `cost` 0/1361 · `price_yes` 36/1331 · `price_no` 30/828 ·
/// `buy_cost` 4/1249 · `sell_return` 1/890 · `shares_for_cost` 34/1212 ·
/// `max_loss_bound` 0/264.
///
/// T03 reported **75**; this suite reports **105**. The difference is exactly
/// the 30 `price_no` comparisons, which are the complements of 30 of the 36
/// `price_yes` disagreements — `price_no` is *defined* as `UNIT − price_yes`,
/// so it cannot disagree independently. Counting the five functions T03
/// counted gives 36 + 4 + 1 + 34 = **75**, identical.
const TOTAL_DISAGREEMENTS: u64 = 105;

/// The lowest skew at which any disagreement was observed, over all 7,135
/// comparisons. Well above [`EXACT_SKEW_LIMIT`] (48); pinned so that a
/// regression which pushes disagreements *down* the skew scale fails even
/// while staying above the hard limit.
const LOWEST_DISAGREEING_SKEW: f64 = 59.0;

/// Cases (not comparisons) in the four files, per `reference/README.md`.
const EXPECTED_CASES: [(&str, usize); 4] = [
    ("grid.json", 2496),
    ("edge.json", 898),
    ("trades.json", 48),
    ("invariants.json", 546),
];

// ---------------------------------------------------------------------------
// Per-function bookkeeping
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Suite {
    cost: Stats,
    price_yes: Stats,
    price_no: Stats,
    buy_cost: Stats,
    sell_return: Stats,
    shares_for_cost: Stats,
    max_loss_bound: Stats,
    cases: usize,
    /// Worst `buy_cost(shares_for_cost(c)) − c`; must never be positive.
    affordability: WorstMax,
    /// Worst vault margin on a replayed sequence, in base units.
    solvency: WorstMin,
}

impl Suite {
    fn new() -> Self {
        Suite {
            cost: Stats::new(),
            price_yes: Stats::new(),
            price_no: Stats::new(),
            buy_cost: Stats::new(),
            sell_return: Stats::new(),
            shares_for_cost: Stats::new(),
            max_loss_bound: Stats::new(),
            ..Default::default()
        }
    }

    fn totals(&self) -> (u64, u64, i128) {
        let mut checks = 0;
        let mut bad = 0;
        let mut worst = 0;
        for s in [
            &self.cost,
            &self.price_yes,
            &self.price_no,
            &self.buy_cost,
            &self.sell_return,
            &self.shares_for_cost,
            &self.max_loss_bound,
        ] {
            checks += s.checks;
            bad += s.disagreements;
            worst = worst.max(s.max_abs_delta);
        }
        (checks, bad, worst)
    }

    fn merge(&mut self, other: &Suite) {
        self.cost.merge(&other.cost);
        self.price_yes.merge(&other.price_yes);
        self.price_no.merge(&other.price_no);
        self.buy_cost.merge(&other.buy_cost);
        self.sell_return.merge(&other.sell_return);
        self.shares_for_cost.merge(&other.shares_for_cost);
        self.max_loss_bound.merge(&other.max_loss_bound);
        self.cases += other.cases;
        if other.affordability.seen
            && (!self.affordability.seen || other.affordability.value > self.affordability.value)
        {
            self.affordability.value = other.affordability.value;
            self.affordability.label = other.affordability.label.clone();
            self.affordability.seen = true;
        }
        if other.solvency.seen
            && (!self.solvency.seen || other.solvency.value < self.solvency.value)
        {
            self.solvency.value = other.solvency.value;
            self.solvency.label = other.solvency.label.clone();
            self.solvency.seen = true;
        }
    }

    fn report(&self, title: &str) {
        let (checks, bad, worst) = self.totals();
        println!("\n== {title} == {} cases, {checks} comparisons", self.cases);
        self.cost.report("cost");
        self.price_yes.report("price_yes");
        self.price_no.report("price_no");
        self.buy_cost.report("buy_cost");
        self.sell_return.report("sell_return");
        self.shares_for_cost.report("shares_for_cost");
        self.max_loss_bound.report("max_loss_bound");
        println!(
            "  {:<18} checks {checks:>6}  disagreements {bad:>4}  max|delta| {worst:>2}",
            "TOTAL"
        );
        if self.affordability.seen {
            println!(
                "  worst buy_cost(shares_for_cost(c)) - c : {:>4}  ({})",
                self.affordability.value, self.affordability.label
            );
        }
        if self.solvency.seen {
            println!(
                "  worst replayed vault margin           : {:>4}  ({})",
                self.solvency.value, self.solvency.label
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Case handlers
// ---------------------------------------------------------------------------

/// A `state` / `state_*` case: `cost`, `price_yes`, `price_no`.
fn check_state(s: &mut Suite, c: &Json) {
    let id = c.str_at("id");
    let (q_yes, q_no, b) = (c.u64_at("q_yes"), c.u64_at("q_no"), c.u64_at("b"));

    let got = cost(q_yes, q_no, b).unwrap_or_else(|e| panic!("{id}: cost -> {e}"));
    s.cost
        .check(&Ctx::state(id, "cost", q_yes, q_no, b), got, c.u64_at("cost"));
    s.cost.note_exact(id, got, c.dec_at("cost_exact"));

    let py = price_yes(q_yes, q_no, b).unwrap_or_else(|e| panic!("{id}: price_yes -> {e}"));
    s.price_yes.check(
        &Ctx::state(id, "price_yes", q_yes, q_no, b),
        py,
        c.u64_at("price_yes"),
    );

    let pn = price_no(q_yes, q_no, b).unwrap_or_else(|e| panic!("{id}: price_no -> {e}"));
    s.price_no.check(
        &Ctx::state(id, "price_no", q_yes, q_no, b),
        pn,
        c.u64_at("price_no"),
    );

    // Structural, not oracle-derived: the pair must sum to UNIT exactly.
    assert_eq!(py + pn, UNIT, "{id}: price_yes + price_no != UNIT");
    assert!(py <= UNIT && pn <= UNIT, "{id}: price outside [0, UNIT]");
}

fn check_buy(s: &mut Suite, c: &Json) {
    let id = c.str_at("id");
    let (q_yes, q_no, b) = (c.u64_at("q_yes"), c.u64_at("q_no"), c.u64_at("b"));
    let outcome = outcome_of(c.str_at("outcome"));
    let shares = c.u64_at("shares");
    let (ay, an) = (c.u64_at("q_yes_after"), c.u64_at("q_no_after"));

    let got = buy_cost(q_yes, q_no, b, outcome, shares)
        .unwrap_or_else(|e| panic!("{id}: buy_cost -> {e}"));
    let ctx = Ctx::trade(id, "buy_cost", q_yes, q_no, ay, an, b);
    s.buy_cost.check(&ctx, got, c.u64_at("collateral_in"));
    s.buy_cost
        .note_exact(id, got, c.dec_at("collateral_in_exact"));

    // Ceil rounding is what protects the vault: the charge must never fall
    // below the exact cost.
    let exact = c.dec_at("collateral_in_exact");
    assert!(
        i128::from(got) >= exact.ceil_units(),
        "{id}: buy_cost {got} is below ceil(exact {exact}) — ceil rounding lost"
    );
}

fn check_sell(s: &mut Suite, c: &Json) {
    let id = c.str_at("id");
    let (q_yes, q_no, b) = (c.u64_at("q_yes"), c.u64_at("q_no"), c.u64_at("b"));
    let outcome = outcome_of(c.str_at("outcome"));
    let shares = c.u64_at("shares");
    let (ay, an) = (c.u64_at("q_yes_after"), c.u64_at("q_no_after"));

    let got = sell_return(q_yes, q_no, b, outcome, shares)
        .unwrap_or_else(|e| panic!("{id}: sell_return -> {e}"));
    let ctx = Ctx::trade(id, "sell_return", q_yes, q_no, ay, an, b);
    s.sell_return.check(&ctx, got, c.u64_at("collateral_out"));
    s.sell_return
        .note_exact(id, got, c.dec_at("collateral_out_exact"));

    let exact = c.dec_at("collateral_out_exact");
    assert!(
        i128::from(got) <= exact.floor_units(),
        "{id}: sell_return {got} exceeds floor(exact {exact}) — floor rounding lost"
    );
}

fn check_shares_for_cost(s: &mut Suite, c: &Json) {
    let id = c.str_at("id");
    let (q_yes, q_no, b) = (c.u64_at("q_yes"), c.u64_at("q_no"), c.u64_at("b"));
    let outcome = outcome_of(c.str_at("outcome"));
    let collateral = c.u64_at("collateral");

    let got = shares_for_cost(q_yes, q_no, b, outcome, collateral)
        .unwrap_or_else(|e| panic!("{id}: shares_for_cost -> {e}"));
    s.shares_for_cost.check(
        &Ctx::state(id, "shares_for_cost", q_yes, q_no, b),
        got,
        c.u64_at("shares"),
    );
    s.shares_for_cost.note_exact(id, got, c.dec_at("shares_exact"));

    // The crate deliberately does not clamp; the flag is the *program's*
    // problem (T07). Assert the flag agrees with what Rust returned.
    let q_out = match outcome {
        Outcome::Yes => q_yes,
        Outcome::No => q_no,
    };
    let over = u128::from(q_out) + u128::from(got) > u128::from(MAX_Q);
    assert_eq!(
        over,
        c.as_bool_at("exceeds_max_q"),
        "{id}: exceeds_max_q disagrees (q_out={q_out} shares={got})"
    );

    // Post-condition of the inverse: what it says you can buy must be
    // affordable with what you offered.
    if !over {
        let back = buy_cost(q_yes, q_no, b, outcome, got)
            .unwrap_or_else(|e| panic!("{id}: buy_cost(shares_for_cost) -> {e}"));
        let slack = i128::from(back) - i128::from(collateral);
        s.affordability.offer(slack, || id.to_string());
        assert!(
            slack <= 0,
            "{id}: shares_for_cost overspends — buy_cost({got}) = {back} > collateral {collateral}"
        );
    }
}

fn check_price_sum(s: &mut Suite, c: &Json) {
    let id = c.str_at("id");
    let (q_yes, q_no, b) = (c.u64_at("q_yes"), c.u64_at("q_no"), c.u64_at("b"));
    let py = price_yes(q_yes, q_no, b).unwrap_or_else(|e| panic!("{id}: price_yes -> {e}"));
    let pn = price_no(q_yes, q_no, b).unwrap_or_else(|e| panic!("{id}: price_no -> {e}"));
    s.price_yes.check(
        &Ctx::state(id, "price_yes", q_yes, q_no, b),
        py,
        c.u64_at("price_yes"),
    );
    s.price_no.check(
        &Ctx::state(id, "price_no", q_yes, q_no, b),
        pn,
        c.u64_at("price_no"),
    );
    assert_eq!(
        py + pn,
        c.u64_at("price_sum"),
        "{id}: price_yes + price_no != {}",
        c.u64_at("price_sum")
    );
}

fn check_max_loss(s: &mut Suite, c: &Json) {
    let id = c.str_at("id");
    let (q_yes, q_no, b) = (c.u64_at("q_yes"), c.u64_at("q_no"), c.u64_at("b"));
    let got = cost(q_yes, q_no, b).unwrap_or_else(|e| panic!("{id}: cost -> {e}"));
    s.cost
        .check(&Ctx::state(id, "cost", q_yes, q_no, b), got, c.u64_at("cost"));

    let bound = max_loss_bound(b).unwrap_or_else(|e| panic!("{id}: max_loss_bound -> {e}"));
    s.max_loss_bound.check(
        &Ctx::state(id, "max_loss_bound", q_yes, q_no, b),
        bound,
        c.u64_at("max_loss_bound"),
    );

    // Plan §1.4 recomputed from Rust's own numbers, not the oracle's:
    // collateral collected is C(q) − C(0,0); the maker pays out max(q).
    let origin = cost(0, 0, b).unwrap_or_else(|e| panic!("{id}: cost(0,0) -> {e}"));
    let collected = i128::from(got) - i128::from(origin);
    for payout in [c.u64_at("payout_yes"), c.u64_at("payout_no")] {
        let loss = i128::from(payout) - collected;
        assert!(
            loss <= i128::from(bound),
            "{id}: loss {loss} exceeds b·ln2 bound {bound} (payout {payout}, collected {collected})"
        );
    }
    assert!(c.as_bool_at("holds"), "{id}: oracle marked holds=false");
}

fn check_max_loss_constant(s: &mut Suite, c: &Json) {
    let id = c.str_at("id");
    let b = c.u64_at("b");
    let bound = max_loss_bound(b).unwrap_or_else(|e| panic!("{id}: max_loss_bound -> {e}"));
    s.max_loss_bound.check(
        &Ctx::state(id, "max_loss_bound", 0, 0, b),
        bound,
        c.u64_at("max_loss_bound"),
    );
    s.max_loss_bound
        .note_exact(id, bound, c.dec_at("max_loss_bound_exact"));

    let origin = cost(0, 0, b).unwrap_or_else(|e| panic!("{id}: cost(0,0) -> {e}"));
    s.cost
        .check(&Ctx::state(id, "cost", 0, 0, b), origin, c.u64_at("cost_at_origin"));
    s.cost.note_exact(id, origin, c.dec_at("cost_at_origin_exact"));

    // ceil vs floor of the same b·ln2: the pair may differ by at most 1.
    let d = i128::from(bound) - i128::from(origin);
    assert!(
        (0..=1).contains(&d),
        "{id}: max_loss_bound {bound} and cost(0,0,b) {origin} differ by {d}"
    );
}

// ---------------------------------------------------------------------------
// trades.json — two replays
// ---------------------------------------------------------------------------

/// Replay one sequence twice.
///
/// **Locked replay** walks the oracle's own states, so each step's outputs are
/// compared against the oracle under identical inputs. That catches per-step
/// error.
///
/// **Free replay** starts from the same initial state but feeds Rust's own
/// `shares_for_cost` answers back into the state, so the two implementations
/// are allowed to diverge and any divergence compounds. That is what catches
/// *cumulative* drift over a 10-step sequence, and it is the run whose vault
/// balance is checked for solvency.
fn check_sequence(s: &mut Suite, c: &Json) {
    let id = c.str_at("id");
    let name = c.str_at("name");
    let b = c.u64_at("b");
    let (q0_yes, q0_no) = (c.u64_at("q_yes"), c.u64_at("q_no"));

    let c_initial = cost(q0_yes, q0_no, b).unwrap_or_else(|e| panic!("{id}: cost -> {e}"));
    s.cost.check(
        &Ctx::state(id, "cost", q0_yes, q0_no, b),
        c_initial,
        c.u64_at("cost_initial"),
    );

    let steps = c.get("steps").expect("steps").arr();
    assert_eq!(steps.len(), c.usize_at("step_count"), "{id}: step_count");

    // ---- locked replay -------------------------------------------------
    let (mut qy, mut qn) = (q0_yes, q0_no);
    let mut net: i128 = 0;
    for st in steps {
        let idx = st.usize_at("index");
        let sid = format!("{id}#{idx}");
        let outcome = outcome_of(st.str_at("outcome"));
        let shares = st.u64_at("shares");
        let (ay, an) = (st.u64_at("q_yes_after"), st.u64_at("q_no_after"));

        match st.str_at("op") {
            "buy" => {
                let got = buy_cost(qy, qn, b, outcome, shares)
                    .unwrap_or_else(|e| panic!("{sid}: buy_cost -> {e}"));
                s.buy_cost.check(
                    &Ctx::trade(&sid, "buy_cost", qy, qn, ay, an, b),
                    got,
                    st.u64_at("collateral_in"),
                );
                net += i128::from(got);
            }
            "sell" => {
                let got = sell_return(qy, qn, b, outcome, shares)
                    .unwrap_or_else(|e| panic!("{sid}: sell_return -> {e}"));
                s.sell_return.check(
                    &Ctx::trade(&sid, "sell_return", qy, qn, ay, an, b),
                    got,
                    st.u64_at("collateral_out"),
                );
                net -= i128::from(got);
            }
            "buy_with_collateral" => {
                let coll = st.u64_at("collateral");
                let got = shares_for_cost(qy, qn, b, outcome, coll)
                    .unwrap_or_else(|e| panic!("{sid}: shares_for_cost -> {e}"));
                s.shares_for_cost.check(
                    &Ctx::state(&sid, "shares_for_cost", qy, qn, b),
                    got,
                    shares,
                );
                net += i128::from(coll);
            }
            other => panic!("{sid}: unknown op {other:?}"),
        }

        qy = ay;
        qn = an;

        let ca = cost(qy, qn, b).unwrap_or_else(|e| panic!("{sid}: cost -> {e}"));
        s.cost
            .check(&Ctx::state(&sid, "cost", qy, qn, b), ca, st.u64_at("cost_after"));
        let pa = price_yes(qy, qn, b).unwrap_or_else(|e| panic!("{sid}: price_yes -> {e}"));
        s.price_yes.check(
            &Ctx::state(&sid, "price_yes", qy, qn, b),
            pa,
            st.u64_at("price_yes_after"),
        );

        // Running balance: Rust's own integers against the oracle's.
        let want_net = st.u64_at("net_collateral_after") as i128;
        let drift = net - want_net;
        assert!(
            drift.abs() <= steps.len() as i128,
            "{sid} ({name}): running vault balance drifted {drift} base units from the oracle \
             after {} steps — more than 1 per step",
            idx + 1
        );
    }

    // ---- free replay ---------------------------------------------------
    let (mut qy, mut qn) = (q0_yes, q0_no);
    let mut net: i128 = 0;
    for st in steps {
        let idx = st.usize_at("index");
        let sid = format!("{id}#{idx}");
        let outcome = outcome_of(st.str_at("outcome"));

        let (delta, is_buy) = match st.str_at("op") {
            "buy" => (st.u64_at("shares"), true),
            "sell" => {
                // Rust's state may hold fewer shares than the oracle's; never
                // oversell, and never let the sequence abort.
                let held = match outcome {
                    Outcome::Yes => qy,
                    Outcome::No => qn,
                };
                (st.u64_at("shares").min(held), false)
            }
            "buy_with_collateral" => {
                let coll = st.u64_at("collateral");
                let n = shares_for_cost(qy, qn, b, outcome, coll)
                    .unwrap_or_else(|e| panic!("{sid}: shares_for_cost -> {e}"));
                (n, true)
            }
            other => panic!("{sid}: unknown op {other:?}"),
        };

        if is_buy {
            let paid = buy_cost(qy, qn, b, outcome, delta)
                .unwrap_or_else(|e| panic!("{sid}: buy_cost -> {e}"));
            // buy_with_collateral spends the whole budget, exactly as the
            // oracle's ledger does.
            net += match st.str_at("op") {
                "buy_with_collateral" => i128::from(st.u64_at("collateral")),
                _ => i128::from(paid),
            };
            match outcome {
                Outcome::Yes => qy += delta,
                Outcome::No => qn += delta,
            }
        } else {
            let got = sell_return(qy, qn, b, outcome, delta)
                .unwrap_or_else(|e| panic!("{sid}: sell_return -> {e}"));
            net -= i128::from(got);
            match outcome {
                Outcome::Yes => qy -= delta,
                Outcome::No => qn -= delta,
            }
        }

        // Solvency, entirely in Rust's numbers: the collateral held must cover
        // the rise in the cost function. Both costs are floored, so the integer
        // margin can sit one base unit below the exact one.
        let ca = cost(qy, qn, b).unwrap_or_else(|e| panic!("{sid}: cost -> {e}"));
        let margin = net - (i128::from(ca) - i128::from(c_initial));
        s.solvency
            .offer(margin, || format!("{sid} ({name}, b={b})"));
        assert!(
            margin >= -1,
            "{sid} ({name}): VAULT DRAIN — collateral {net} does not cover the rise in cost \
             ({ca} - {c_initial}); margin {margin}"
        );
    }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

fn run_file(name: &str) -> Suite {
    let f = load_vectors(name);
    let mut s = Suite::new();
    s.cases = f.cases.len();
    for c in &f.cases {
        match c.str_at("type") {
            t if t.starts_with("state") => check_state(&mut s, c),
            "buy" => check_buy(&mut s, c),
            "sell" => check_sell(&mut s, c),
            "shares_for_cost" => check_shares_for_cost(&mut s, c),
            "price_sum" => check_price_sum(&mut s, c),
            "max_loss" => check_max_loss(&mut s, c),
            "max_loss_constant" => check_max_loss_constant(&mut s, c),
            "sequence" => check_sequence(&mut s, c),
            other => panic!("{}: unhandled case type {other:?}", c.str_at("id")),
        }
    }
    // Every comparison this file could make must actually have been made.
    let (checks, _, _) = s.totals();
    assert!(checks > 0, "{name}: no comparisons ran");
    s
}

#[test]
fn grid_vectors_conform() {
    let s = run_file("grid.json");
    s.report("grid.json");
}

#[test]
fn edge_vectors_conform() {
    let s = run_file("edge.json");
    s.report("edge.json");
}

#[test]
fn invariant_vectors_conform() {
    let s = run_file("invariants.json");
    s.report("invariants.json");
}

#[test]
fn trade_sequences_conform_without_cumulative_drift() {
    let s = run_file("trades.json");
    s.report("trades.json");
}

/// The whole envelope in one place: every file, every case, and the totals
/// pinned to what was measured. This is the test that fails if the number of
/// `±1` disagreements grows, even though each one on its own is in tolerance.
#[test]
fn envelope_over_all_vectors_matches_the_measured_bound() {
    let mut total = Suite::new();
    for (name, expected) in EXPECTED_CASES {
        let s = run_file(name);
        assert_eq!(s.cases, expected, "{name}: case count changed");
        s.report(name);
        total.merge(&s);
    }
    total.report("ALL VECTORS");

    let (checks, bad, worst) = total.totals();
    let cases: usize = EXPECTED_CASES.iter().map(|(_, n)| n).sum();
    println!(
        "\nT04 conformance: {cases} cases -> {checks} comparisons, {bad} disagreements \
         ({:.3}%), worst |delta| {worst} base unit(s)",
        100.0 * bad as f64 / checks as f64
    );

    assert_eq!(cases, 3_988, "vector corpus size changed");
    assert_eq!(
        checks, TOTAL_COMPARISONS,
        "comparison count changed — coverage moved, update TOTAL_COMPARISONS deliberately"
    );
    assert!(worst <= 1, "worst disagreement {worst} exceeds 1 base unit");
    assert!(
        bad <= TOTAL_DISAGREEMENTS,
        "disagreements rose to {bad} (measured baseline {TOTAL_DISAGREEMENTS})"
    );
    // A collapse to zero would mean the comparison stopped comparing.
    assert!(bad > 0, "no disagreements at all — is the suite still running?");

    // Not just "above the hard limit" — above where it was actually measured.
    for (name, st) in [
        ("cost", &total.cost),
        ("price_yes", &total.price_yes),
        ("price_no", &total.price_no),
        ("buy_cost", &total.buy_cost),
        ("sell_return", &total.sell_return),
        ("shares_for_cost", &total.shares_for_cost),
        ("max_loss_bound", &total.max_loss_bound),
    ] {
        assert!(
            st.min_bad_skew >= LOWEST_DISAGREEING_SKEW,
            "{name}: a disagreement appeared at skew {:.4} ({}), below the measured floor \
             {LOWEST_DISAGREEING_SKEW}",
            st.min_bad_skew,
            st.worst_id
        );
    }
}
