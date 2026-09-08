//! Ticket T04 item 4 — the compute-unit cost of Q64.64 `i128` maths on Solana,
//! **measured**, not assumed.
//!
//! `docs/DESIGN_DECISIONS.md` D1 says: *"`i128` multiply/divide is more compute
//! units than `i64`. A binary market needs only a small, bounded number of
//! `exp`/`ln` calls per instruction, so this stays well inside Solana's
//! per-instruction compute budget. T04 measures the actual CU cost so the
//! assumption is verified rather than assumed."*
//!
//! # Verdict
//!
//! **Q64.64 fits. No format change is needed. But "well inside" overstates
//! it.**
//!
//! Measured in the VM, a full `buy_shares`-shaped sequence
//! (`shares_for_cost` → `buy_cost` → `price_yes`) costs **64,229 CU** at a
//! typical state — **32% of the 200,000 CU default per-instruction budget**,
//! before Anchor account deserialisation, the SPL token CPI, or
//! `init_if_needed` on the `UserPosition` PDA. Taking each function's *worst*
//! column instead (a conservative bound; the corners cannot all co-occur) gives
//! **86,319 CU, 43%** of the default.
//!
//! So the headroom on the hot path is **2.3×**, not 100×. The consequences for
//! T07:
//!
//! * the collateral-denominated `buy_shares` is the expensive instruction, and
//!   it leaves roughly 114,000 CU for everything Anchor and SPL do around it;
//! * **at most two `shares_for_cost`-class calls** (≈48k CU each) may appear on
//!   any one instruction — three would not fit
//!   [`LMSR_BUDGET_CEILING`];
//! * if a path ever does need more, `ComputeBudgetInstruction::
//!   set_compute_unit_limit` raises a transaction to 1,400,000 CU. That is a
//!   real escape hatch, but it costs the caller priority fees, so it is a
//!   fallback rather than the plan.
//!
//! # How the numbers were obtained
//!
//! Not modelled — executed, in the real sBPF VM, at the toolchain versions
//! `docs/TOOLCHAIN.md` pins (`cargo-build-sbf 3.1.10`, platform-tools v1.52,
//! `--arch v0`, `release` profile with `overflow-checks = true`, `lto = "fat"`,
//! `codegen-units = 1`).
//!
//! A probe program calls one LMSR function `reps` times in a loop; the harness
//! sends the same op with `reps = 0` and `reps = 16` and differences the
//! `compute_units_consumed` LiteSVM reports, so entrypoint, deserialisation and
//! the compute-budget instruction cancel exactly. Cost is linear in `reps`
//! (1 rep and 4 reps agree with 16 reps to <0.1%) and byte-identical across
//! runs.
//!
//! Sources and a runner are in `crates/lmsr/benches/solana_cu_probe/`;
//! `cargo bench -p lmsr` prints the same table alongside native timings.
//!
//! # Measured (CU per call, `--arch v0`)
//!
//! | function | typical state | max skew, `b = B_MIN` |
//! |---|---:|---:|
//! | `cost` | **18,579** | 9,973 |
//! | `price_yes` | **12,315** | 11,933 |
//! | `buy_cost` | **25,732** | 12,574 |
//! | `sell_return` | **25,730** | 12,568 |
//! | `shares_for_cost` | **25,243** | **48,272** |
//! | `max_loss_bound` | **146** | — |
//! | *`buy_shares`-shaped* (`shares_for_cost` + `buy_cost` + `price_yes`) | **64,229** | 49,379 |
//!
//! Primitive breakdown, which is where all of it goes:
//!
//! | primitive | CU |
//! |---|---:|
//! | `Fixed::exp` | 7,284 |
//! | `Fixed::ln` | 7,581 |
//! | `Fixed::expm1` | 7,333 |
//! | `Fixed::from_ratio` (one 128-bit divide) | 2,944 |
//!
//! Two things follow. First, the cost is **all** in the transcendentals: `cost`
//! is one `from_ratio` + one `exp` + one `ln` + a multiply, and
//! `2,944 + 7,284 + 7,581 = 17,809` accounts for 96% of its 18,579. Second,
//! `overflow-checks` is **free** — rebuilding with `overflow-checks = false`
//! moved every figure by less than 0.05%, because the crate already does every
//! operation through a `checked_*` call. Keeping it on costs nothing.
//!
//! Counter-intuitively the *typical* path is the expensive one: at maximum skew
//! the `exp` series underflows after a couple of terms, so the deep-skew corner
//! is cheaper than a balanced market for everything except `shares_for_cost`
//! (which takes its log-domain branch there — 48,272 CU, the single most
//! expensive call in the crate).
//!
//! # What this test asserts
//!
//! The numbers above are recorded constants: `cargo test` has no Solana VM, so
//! it cannot re-measure them. What it *can* do is hold the budget arithmetic to
//! account, which is the part that would silently rot — if T07 adds a third
//! LMSR call to `buy_shares`, [`LMSR_BUDGET_CEILING`] is what fails.

/// Solana's default compute budget for a single instruction.
const DEFAULT_INSTRUCTION_BUDGET: u32 = 200_000;

/// The most a transaction can request with `ComputeBudgetInstruction::
/// set_compute_unit_limit` — the escape hatch if an instruction ever needs it.
const MAX_REQUESTABLE_BUDGET: u32 = 1_400_000;

/// The most CU the LMSR maths may consume on any one instruction path.
///
/// Half the default budget. The other half is for Anchor's account
/// deserialisation and constraint checks, the SPL token CPI, and
/// `init_if_needed` on the `UserPosition` PDA — T09's on-chain tests will
/// measure that side. Set as a *budget*, not as a fit to the measurement: at
/// 64,229 CU the worst path uses 64% of this allowance, so one more
/// `price_yes` (12,315) still fits and a second `shares_for_cost` (25,243)
/// does not.
const LMSR_BUDGET_CEILING: u32 = 100_000;

/// `(name, measured CU/call)`, `--arch v0`, release, overflow-checks on.
/// See the module docs for provenance.
const MEASURED: &[(&str, u32)] = &[
    ("cost                        typical", 18_579),
    ("price_yes                   typical", 12_315),
    ("buy_cost                    typical", 25_732),
    ("sell_return                 typical", 25_730),
    ("shares_for_cost             typical", 25_243),
    ("max_loss_bound                     ", 146),
    ("cost                       max skew", 9_973),
    ("price_yes                  max skew", 11_933),
    ("buy_cost                   max skew", 12_574),
    ("sell_return                max skew", 12_568),
    ("shares_for_cost            max skew", 48_272),
    ("Fixed::exp                         ", 7_284),
    ("Fixed::ln                          ", 7_581),
    ("Fixed::expm1                       ", 7_333),
    ("Fixed::from_ratio                  ", 2_944),
];

/// The instruction shapes T05–T08 will actually build, and the LMSR calls each
/// needs.
///
/// Each entry takes that function's **worst** column, so the totals are an
/// upper bound rather than a measurement — the typical and max-skew corners
/// cannot co-occur inside one call sequence. The in-VM measurement of the same
/// `buy_shares` sequence is 64,229 CU (typical) and 49,379 CU (max skew)
/// against the 86,319 CU this bound gives.
const INSTRUCTION_PATHS: &[(&str, &[(&str, u32)])] = &[
    (
        "create_market",
        &[("max_loss_bound", 146), ("cost(0,0,b)", 18_579)],
    ),
    (
        "buy_shares (collateral-denominated)",
        &[
            ("shares_for_cost", 48_272),
            ("buy_cost", 25_732),
            ("price_yes", 12_315),
        ],
    ),
    (
        "buy_shares (share-denominated)",
        &[("buy_cost", 25_732), ("price_yes", 12_315)],
    ),
    (
        "sell_shares",
        &[("sell_return", 25_730), ("price_yes", 12_315)],
    ),
    ("redeem", &[]),
];

#[test]
fn the_lmsr_fits_inside_solanas_compute_budget() {
    println!("\nMeasured CU per call (sBPF v0, release, overflow-checks on):");
    for (name, cu) in MEASURED {
        println!("  {name}  {cu:>7}");
    }

    println!(
        "\nPer-instruction LMSR cost vs the {DEFAULT_INSTRUCTION_BUDGET} CU default budget:"
    );
    let mut worst = ("", 0u32);
    for (path, calls) in INSTRUCTION_PATHS {
        let total: u32 = calls.iter().map(|(_, cu)| cu).sum();
        let pct = 100.0 * f64::from(total) / f64::from(DEFAULT_INSTRUCTION_BUDGET);
        println!(
            "  {path:<38} {total:>7} CU  ({pct:>5.1}% of default, {:.1}x headroom)  [{}]",
            f64::from(DEFAULT_INSTRUCTION_BUDGET) / f64::from(total.max(1)),
            calls
                .iter()
                .map(|(n, _)| *n)
                .collect::<Vec<_>>()
                .join(" + ")
        );
        if total > worst.1 {
            worst = (path, total);
        }
    }

    println!(
        "\nworst path: {} at {} CU = {:.1}% of the {DEFAULT_INSTRUCTION_BUDGET} CU default; \
         ceiling for LMSR maths is {LMSR_BUDGET_CEILING} CU, and a transaction may request up \
         to {MAX_REQUESTABLE_BUDGET} CU if it ever needs to.",
        worst.0,
        worst.1,
        100.0 * f64::from(worst.1) / f64::from(DEFAULT_INSTRUCTION_BUDGET)
    );

    assert!(
        worst.1 <= LMSR_BUDGET_CEILING,
        "the LMSR maths on '{}' now costs {} CU, past the {LMSR_BUDGET_CEILING} CU allowance \
         (half of Solana's {DEFAULT_INSTRUCTION_BUDGET} CU default). Either drop an LMSR call \
         from that instruction or re-measure with \
         crates/lmsr/benches/solana_cu_probe/run.sh and move the ceiling deliberately.",
        worst.0,
        worst.1
    );
    assert!(
        worst.1 < DEFAULT_INSTRUCTION_BUDGET,
        "an instruction's LMSR maths alone exceeds Solana's default budget"
    );
}

/// The single most expensive call in the crate, on its own, against the budget.
///
/// `shares_for_cost` at maximum skew takes the log-domain branch: two `exp`,
/// two `ln`, an `expm1` and a 48-term series. At 48,272 CU it is 24% of the
/// default budget by itself, so no instruction may call it twice.
#[test]
fn the_most_expensive_single_call_is_shares_for_cost_at_max_skew() {
    const WORST_SINGLE_CALL: u32 = 48_272;
    let (name, cu) = MEASURED
        .iter()
        .filter(|(n, _)| !n.starts_with("Fixed::"))
        .max_by_key(|(_, cu)| *cu)
        .copied()
        .expect("table is not empty");
    assert_eq!(cu, WORST_SINGLE_CALL);
    assert!(
        name.starts_with("shares_for_cost"),
        "the worst call moved to {name}"
    );
    // The budget arithmetic T07 has to live with, stated as an assertion: two
    // of these fit the allowance, three do not.
    assert!(
        2 * cu <= LMSR_BUDGET_CEILING,
        "two {name} calls ({} CU) no longer fit the {LMSR_BUDGET_CEILING} CU allowance",
        2 * cu
    );
    assert!(
        3 * cu > LMSR_BUDGET_CEILING,
        "three {name} calls now fit — the ceiling has drifted away from the measurement"
    );
    println!(
        "worst single call: {name} at {cu} CU ({:.1}% of the default budget); \
         two fit the {LMSR_BUDGET_CEILING} CU allowance ({} CU), three do not ({} CU)",
        100.0 * f64::from(cu) / f64::from(DEFAULT_INSTRUCTION_BUDGET),
        2 * cu,
        3 * cu
    );
}

/// Internal consistency: `cost` is one `from_ratio`, one `exp`, one `ln` and a
/// multiply, so its measured cost must be explained by the primitives.
///
/// This is what catches a stale table — if someone updates the function figures
/// without re-measuring the primitives (or the reverse), the two stop adding up.
#[test]
fn the_primitive_breakdown_explains_the_function_costs() {
    let get = |k: &str| -> u32 {
        MEASURED
            .iter()
            .find(|(n, _)| n.trim_end() == k)
            .unwrap_or_else(|| panic!("no row {k:?}"))
            .1
    };
    let parts = get("Fixed::from_ratio") + get("Fixed::exp") + get("Fixed::ln");
    let whole = get("cost                        typical");
    let ratio = f64::from(parts) / f64::from(whole);
    println!(
        "cost = {whole} CU; from_ratio + exp + ln = {parts} CU ({:.0}% of it)",
        100.0 * ratio
    );
    assert!(
        (0.90..=1.00).contains(&ratio),
        "the primitives account for {:.0}% of `cost` — the table is inconsistent",
        100.0 * ratio
    );
}
