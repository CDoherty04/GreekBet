//! # GreekBet LMSR core
//!
//! A standalone, dependency-free, `no_std` implementation of Hanson's
//! Logarithmic Market Scoring Rule for a **binary** market, written so that a
//! Solana program can treat it as a trusted dependency. There are no Solana or
//! Anchor types anywhere in this crate, and no floating point outside
//! `#[cfg(test)]`.
//!
//! ```text
//! C(q_yes, q_no) = b · ln( e^(q_yes/b) + e^(q_no/b) )
//! price_yes      = e^(q_yes/b) / ( e^(q_yes/b) + e^(q_no/b) )
//! price_no       = 1 − price_yes
//! ```
//!
//! ## Units — everything is an integer count of base units
//!
//! Every value crossing this crate's boundary is a plain `u64` count of
//! **6-decimal base units**:
//!
//! ```text
//! 1_000_000 base units == 1 USDC == 1 share
//! ```
//!
//! Prices use the same scale, so `500_000` is a price of `0.5` and
//! [`UNIT`] is `1.0`. There is no USDC-denominated floating-point value
//! anywhere; see [`bounds`] for the frozen domain.
//!
//! ## Fixed-point format
//!
//! Internally the crate computes in **Q64.64 signed fixed point** carried in an
//! `i128` ([`fixed::Fixed`]): 64 integer bits, 64 fractional bits, one ulp of
//! `2^-64 ≈ 5.42e-20`. That representation never crosses the public boundary —
//! it is an implementation detail of [`lmsr`], fixed by
//! `docs/DESIGN_DECISIONS.md` D1.
//!
//! The cost function is always evaluated in the log-sum-exp stabilised form
//! (D4), so both `exp` arguments are `≤ 0` and neither can overflow however
//! large `q` is or however small `b` is.
//!
//! ## Rounding policy
//!
//! Money never rounds in the user's favour, or the vault drains over many small
//! trades. This matches `reference/lmsr_ref.py` exactly.
//!
//! | function | direction |
//! |---|---|
//! | [`cost`] | floor |
//! | [`price_yes`] | floor of `p · UNIT` |
//! | [`price_no`] | **`UNIT − price_yes`** — the complement, so the pair sums to `UNIT` exactly |
//! | [`buy_cost`] | **ceil** |
//! | [`sell_return`] | **floor** |
//! | [`shares_for_cost`] | floor |
//! | [`max_loss_bound`] | ceil |
//!
//! [`buy_cost`] and [`sell_return`] round the exact trade difference **once**;
//! they are not `cost(new) − cost(old)` on already-rounded costs.
//!
//! ## Safety contract
//!
//! * No public function panics on any input. Every fallible operation returns
//!   [`LmsrError`]. There is no `unwrap`, `expect`, `panic!`, unchecked
//!   arithmetic or indexing outside `#[cfg(test)]`.
//! * `#![no_std]`, zero dependencies, builds for the Solana SBF target.
//! * `overflow-checks` stays on in release, so an escaped case aborts rather
//!   than wraps.
//!
//! ## Example
//!
//! ```
//! use lmsr::{buy_cost, price_yes, shares_for_cost, Outcome, UNIT};
//!
//! let b = 100_000_000;                    // 100 USDC of liquidity
//! assert_eq!(price_yes(0, 0, b)?, UNIT / 2);
//!
//! // Spend 10 USDC on YES, then check the quoted cost of exactly that many
//! // shares never exceeds what was spent.
//! let shares = shares_for_cost(0, 0, b, Outcome::Yes, 10_000_000)?;
//! assert!(buy_cost(0, 0, b, Outcome::Yes, shares)? <= 10_000_000);
//! # Ok::<(), lmsr::LmsrError>(())
//! ```

#![no_std]

#[cfg(test)]
extern crate std;

pub mod bounds;
pub mod error;
pub mod fixed;
pub mod lmsr;

pub use bounds::{validate_b, validate_q, B_MAX, B_MIN, DECIMALS, MAX_Q, UNIT};
pub use error::{LmsrError, Result};
pub use fixed::{Fixed, FixedError};
pub use lmsr::{
    buy_cost, cost, max_loss_bound, price_no, price_yes, sell_return, shares_for_cost, Outcome,
};
