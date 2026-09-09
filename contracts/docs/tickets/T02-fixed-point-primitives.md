# T02 — Q64.64 fixed-point primitives

**Depends on:** T00 · **Blocks:** T03
**Owns:** `crates/lmsr/src/fixed.rs`, `crates/lmsr/Cargo.toml`

## Context

Plan §1.2. Solana has no floating point. This ticket builds the arithmetic layer
only — no LMSR semantics. T03 sits on top of it.

Format is **frozen** as Q64.64 in `i128` (see `docs/DESIGN_DECISIONS.md`): 64
integer bits, 64 fractional bits, one unit = `2^-64`.

## Goal

A correct, overflow-safe, `no_std`-compatible fixed-point module with `exp` and
`ln`, unit-tested against known values.

## Tasks

1. Create the crate at `crates/lmsr/`:
   - `#![no_std]` (add `#[cfg(test)] extern crate std;` for tests).
   - **Zero Solana/Anchor dependencies.** Plan §1.2 requires it be testable with
     plain `cargo test`. Keep `Cargo.toml` dependency-light; `proptest` as a
     dev-dependency is fine.
2. `struct Q64_64(i128)` (name it idiomatically) with:
   - Conversions: `from_int`, `from_ratio(num, den)`, `to_int_floor/ceil`,
     `from_base_units(u64)` / `to_base_units_floor/ceil` for the 6-decimal
     boundary, and a `to_f64` available **only under `#[cfg(test)]`** so it can
     never leak into on-chain code.
   - Checked arithmetic: `checked_add`, `checked_sub`, `checked_mul`,
     `checked_div`. Every operation returns `Result`/`Option` — **no silent
     wrapping, no `unwrap`, no panics on the on-chain path.** `mul` must handle
     the `i128 × i128 >> 64` intermediate without overflowing; use a 256-bit
     widening step (hand-rolled from `u128` halves, or a small dependency).
   - Constants: `ONE`, `ZERO`, `LN_2`, `E`.
3. `exp(x)` for `x ≤ 0`:
   - **This is the only domain T03 needs** — the log-sum-exp form in
     `docs/DESIGN_DECISIONS.md` guarantees non-positive arguments. Implement the
     general case if you like, but the negative domain is what must be correct.
   - Suggested approach: range-reduce `x = -k·ln2 − r` with `r ∈ [0, ln2)`, evaluate
     `exp(−r)` by a minimax polynomial or Taylor series to full Q64.64 precision,
     then shift right by `k`. Underflow to `0` for very negative `x` is the
     **correct** result, not an error — make that explicit and tested.
4. `ln(x)` for `x > 0`:
   - Range-reduce to `x = 2^k · m` with `m ∈ [1, 2)`, then
     `ln x = k·ln2 + ln(m)` via `atanh` series or a minimax polynomial.
   - `ln(0)` and `ln(negative)` return an error, never panic.
5. Unit tests in-module (`#[cfg(test)]`):
   - Known values: `exp(0)=1`, `exp(−ln2)=0.5`, `ln(1)=0`, `ln(2)=LN_2`,
     `ln(e)=1`.
   - Round-trip: `ln(exp(x)) ≈ x` across the negative domain.
   - Monotonicity of both functions across a dense sweep.
   - Accuracy vs `f64` (test-only) across the working range — assert a stated
     max relative error and **write that bound in a doc comment**; T04 will hold
     you to it.
   - Boundary behavior: `i128::MAX/MIN` inputs, extreme underflow, division by
     zero — all must return errors rather than panic or wrap.

## Definition of done

- `cargo test -p lmsr` passes in WSL.
- `cargo build -p lmsr --release` is clean, no warnings.
- No panicking paths reachable from public APIs with any input (no `unwrap`,
  `expect`, indexing, or unchecked arithmetic on those paths).
- Documented accuracy bound for `exp` and `ln`.

## Report back

The accuracy bound achieved, the algorithms chosen for `exp`/`ln`, how the
128×128 multiply is handled, and any dependency you added with justification.
