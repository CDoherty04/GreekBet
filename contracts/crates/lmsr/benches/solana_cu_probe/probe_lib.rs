//! Compute-unit probe program for the GreekBet LMSR crate (T04 item 4).
//!
//! Copied to `$HOME/gb-cu/probe/src/lib.rs` by `run.sh` and built with
//! `cargo-build-sbf --arch v0`. Instruction data is
//! `[op, reps_lo, reps_hi, seed]`; the harness differences two `reps` values so
//! entrypoint and deserialisation cancel. Every argument depends on the loop
//! counter and on `seed`, so nothing can be hoisted or constant folded.

use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
};

entrypoint!(process);

const MAX_Q: u64 = 1_000_000_000_000_000;
const B_MIN: u64 = 10_000_000;

fn process(_id: &Pubkey, _accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 4 {
        return Ok(());
    }
    let op = data[0];
    let reps = u16::from_le_bytes([data[1], data[2]]) as u64;
    let seed = data[3] as u64;

    // "typical": a balanced-ish market at 1,000 USDC of liquidity.
    let tb = 1_000_000_000u64 + seed;
    let tqy = 123_456_789u64 + seed;
    let tqn = 987_654_321u64 + seed;
    // "worst": maximum skew at minimum b — the b_small_softplus path.
    let wb = B_MIN;
    let wqy = MAX_Q - seed;
    let wqn = seed;

    let mut acc = 0u64;
    let mut i = 0u64;
    while i < reps {
        let r = match op {
            0 => lmsr::cost(tqy + i, tqn, tb),
            1 => lmsr::price_yes(tqy + i, tqn, tb),
            2 => lmsr::buy_cost(tqy + i, tqn, tb, lmsr::Outcome::Yes, 1_000_000),
            3 => lmsr::sell_return(tqy + i, tqn, tb, lmsr::Outcome::Yes, 1_000_000),
            4 => lmsr::shares_for_cost(tqy + i, tqn, tb, lmsr::Outcome::Yes, 1_000_000),
            5 => lmsr::max_loss_bound(tb + i),
            6 => lmsr::cost(wqy - i, wqn, wb),
            7 => lmsr::price_yes(wqy - i, wqn, wb),
            8 => lmsr::buy_cost(wqy - i, wqn, wb, lmsr::Outcome::No, 1_000_000),
            9 => lmsr::sell_return(wqy - i, wqn, wb, lmsr::Outcome::Yes, 1_000_000),
            10 => lmsr::shares_for_cost(wqy - i, wqn, wb, lmsr::Outcome::No, 1_000_000),
            // A whole `buy_shares`-shaped instruction: quote what a spend buys,
            // price it, then revalue the market.
            11 => {
                let n = lmsr::shares_for_cost(tqy + i, tqn, tb, lmsr::Outcome::Yes, 5_000_000)
                    .unwrap_or(0);
                let c = lmsr::buy_cost(tqy + i, tqn, tb, lmsr::Outcome::Yes, n).unwrap_or(0);
                let p = lmsr::price_yes(tqy + i + n, tqn, tb).unwrap_or(0);
                Ok(c ^ p ^ n)
            }
            12 => {
                let n = lmsr::shares_for_cost(wqy - i, wqn, wb, lmsr::Outcome::No, 5_000_000)
                    .unwrap_or(0);
                let c = lmsr::buy_cost(wqy - i, wqn, wb, lmsr::Outcome::No, n.min(1_000_000))
                    .unwrap_or(0);
                let p = lmsr::price_yes(wqy - i, wqn, wb).unwrap_or(0);
                Ok(c ^ p ^ n)
            }
            // Primitives, so the function costs above can be attributed.
            13 => Ok(lmsr::Fixed::from_int(-3)
                .checked_sub(lmsr::Fixed::from_raw(i as i128))
                .unwrap()
                .exp()
                .map(|v| v.to_raw() as u64)
                .unwrap_or(0)),
            14 => Ok(lmsr::Fixed::from_int(1234)
                .checked_add(lmsr::Fixed::from_raw(i as i128))
                .unwrap()
                .ln()
                .map(|v| v.to_raw() as u64)
                .unwrap_or(0)),
            15 => Ok(
                lmsr::Fixed::from_ratio(-(tqy as i128) - i as i128, tb as i128)
                    .map(|v| v.to_raw() as u64)
                    .unwrap_or(0),
            ),
            16 => Ok(lmsr::Fixed::from_int(-3)
                .checked_sub(lmsr::Fixed::from_raw(i as i128))
                .unwrap()
                .expm1()
                .map(|v| v.to_raw() as u64)
                .unwrap_or(0)),
            _ => Ok(0),
        };
        acc = acc.wrapping_add(r.unwrap_or(1));
        i += 1;
    }
    core::hint::black_box(acc);
    Ok(())
}
