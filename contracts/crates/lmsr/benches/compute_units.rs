//! Cost of the LMSR core, two ways: the **measured** Solana compute-unit
//! figures from `solana_cu_probe/`, and a native timing run that anyone can
//! reproduce with plain `cargo bench` and no Solana toolchain.
//!
//! ```text
//! cargo bench -p lmsr
//! ```
//!
//! The native numbers are not compute units and must never be reported as such
//! — an x86-64 host and the sBPF VM have nothing in common. They are here as a
//! **regression tripwire**: the two columns are roughly proportional (both are
//! dominated by the same 128-bit multiply/divide chain), so if a change makes a
//! function 2× slower natively, its on-chain cost has almost certainly moved
//! too and `solana_cu_probe/run.sh` should be re-run.
//!
//! `harness = false`: this is a plain `main`, not a `#[bench]` — the built-in
//! bench harness is nightly-only and the crate is dependency-free by design, so
//! there is no `criterion` either.

use lmsr::{
    buy_cost, cost, max_loss_bound, price_yes, sell_return, shares_for_cost, Fixed, Outcome, B_MIN,
    MAX_Q,
};
use std::hint::black_box;
use std::time::Instant;

/// Recorded on-chain cost, `--arch v0`, release, `overflow-checks = true`.
/// Provenance and the full table are in `crates/lmsr/tests/compute_budget.rs`.
const RECORDED_CU: &[(&str, u32)] = &[
    ("cost                 typical", 18_579),
    ("price_yes            typical", 12_315),
    ("buy_cost             typical", 25_732),
    ("sell_return          typical", 25_730),
    ("shares_for_cost      typical", 25_243),
    ("max_loss_bound              ", 146),
    ("cost                max skew", 9_973),
    ("price_yes           max skew", 11_933),
    ("buy_cost            max skew", 12_574),
    ("sell_return         max skew", 12_568),
    ("shares_for_cost     max skew", 48_272),
    ("Fixed::exp                  ", 7_284),
    ("Fixed::ln                   ", 7_581),
    ("Fixed::expm1                ", 7_333),
    ("Fixed::from_ratio           ", 2_944),
];

const REPS: u64 = 200_000;

fn bench(name: &str, mut f: impl FnMut(u64) -> u64) -> (String, f64) {
    // Warm up, then time. `i` varies every call so nothing can be hoisted.
    let mut acc = 0u64;
    for i in 0..1_000 {
        acc = acc.wrapping_add(f(i));
    }
    black_box(acc);

    let t = Instant::now();
    let mut acc = 0u64;
    for i in 0..REPS {
        acc = acc.wrapping_add(f(i));
    }
    let ns = t.elapsed().as_nanos() as f64 / REPS as f64;
    black_box(acc);
    (name.to_string(), ns)
}

fn main() {
    // Typical: a balanced-ish market with 1,000 USDC of liquidity.
    let (tb, tqy, tqn) = (1_000_000_000u64, 123_456_789u64, 987_654_321u64);
    // Worst: maximum skew at minimum b — the b_small_softplus path.
    let (wb, wqy, wqn) = (B_MIN, MAX_Q, 0u64);

    let rows = vec![
        bench("cost                 typical", |i| {
            cost(black_box(tqy + i), black_box(tqn), black_box(tb)).unwrap_or(0)
        }),
        bench("price_yes            typical", |i| {
            price_yes(black_box(tqy + i), black_box(tqn), black_box(tb)).unwrap_or(0)
        }),
        bench("buy_cost             typical", |i| {
            buy_cost(
                black_box(tqy + i),
                black_box(tqn),
                black_box(tb),
                Outcome::Yes,
                1_000_000,
            )
            .unwrap_or(0)
        }),
        bench("sell_return          typical", |i| {
            sell_return(
                black_box(tqy + i),
                black_box(tqn),
                black_box(tb),
                Outcome::Yes,
                1_000_000,
            )
            .unwrap_or(0)
        }),
        bench("shares_for_cost      typical", |i| {
            shares_for_cost(
                black_box(tqy + i),
                black_box(tqn),
                black_box(tb),
                Outcome::Yes,
                1_000_000,
            )
            .unwrap_or(0)
        }),
        bench("max_loss_bound              ", |i| {
            max_loss_bound(black_box(tb + i)).unwrap_or(0)
        }),
        bench("cost                max skew", |i| {
            cost(black_box(wqy - i), black_box(wqn), black_box(wb)).unwrap_or(0)
        }),
        bench("price_yes           max skew", |i| {
            price_yes(black_box(wqy - i), black_box(wqn), black_box(wb)).unwrap_or(0)
        }),
        bench("buy_cost            max skew", |i| {
            buy_cost(
                black_box(wqy - i),
                black_box(wqn),
                black_box(wb),
                Outcome::No,
                1_000_000,
            )
            .unwrap_or(0)
        }),
        bench("sell_return         max skew", |i| {
            sell_return(
                black_box(wqy - i),
                black_box(wqn),
                black_box(wb),
                Outcome::Yes,
                1_000_000,
            )
            .unwrap_or(0)
        }),
        bench("shares_for_cost     max skew", |i| {
            shares_for_cost(
                black_box(wqy - i),
                black_box(wqn),
                black_box(wb),
                Outcome::No,
                1_000_000,
            )
            .unwrap_or(0)
        }),
        bench("Fixed::exp                  ", |i| {
            Fixed::from_int(-3)
                .checked_sub(Fixed::from_raw(black_box(i as i128)))
                .and_then(|v| v.exp().ok())
                .map_or(0, |v| v.to_raw() as u64)
        }),
        bench("Fixed::ln                   ", |i| {
            Fixed::from_int(1234)
                .checked_add(Fixed::from_raw(black_box(i as i128)))
                .and_then(|v| v.ln().ok())
                .map_or(0, |v| v.to_raw() as u64)
        }),
        bench("Fixed::expm1                ", |i| {
            Fixed::from_int(-3)
                .checked_sub(Fixed::from_raw(black_box(i as i128)))
                .and_then(|v| v.expm1().ok())
                .map_or(0, |v| v.to_raw() as u64)
        }),
        bench("Fixed::from_ratio           ", |i| {
            Fixed::from_ratio(-i128::from(black_box(tqy + i)), i128::from(tb))
                .map_or(0, |v| v.to_raw() as u64)
        }),
    ];

    println!("\nlmsr cost profile  ({REPS} iterations each)\n");
    println!(
        "{:<30} {:>12} {:>14} {:>12}",
        "op", "native ns", "on-chain CU", "CU per ns"
    );
    println!("{}", "-".repeat(72));
    for (name, ns) in &rows {
        match RECORDED_CU.iter().find(|(n, _)| n == name) {
            Some((_, cu)) => println!(
                "{name:<30} {ns:>12.1} {cu:>14} {:>12.0}",
                f64::from(*cu) / ns.max(f64::MIN_POSITIVE)
            ),
            None => println!("{name:<30} {ns:>12.1} {:>14}", "-"),
        }
    }
    println!(
        "\non-chain figures: sBPF v0, release, overflow-checks on — measured with\n\
         crates/lmsr/benches/solana_cu_probe/run.sh, asserted against Solana's\n\
         200,000 CU default budget in crates/lmsr/tests/compute_budget.rs.\n\
         Native nanoseconds are a proportionality tripwire only, never a CU estimate."
    );
}
