# T03 — LMSR core API

**Depends on:** T02 · **Blocks:** T04, T07
**Owns:** `crates/lmsr/src/lmsr.rs`, `crates/lmsr/src/bounds.rs`,
`crates/lmsr/src/error.rs`, `crates/lmsr/src/lib.rs`

## Context

Plan §1.1, §1.4, §1.5. This is the deliverable the Anchor program treats as a
trusted dependency. Do not touch `fixed.rs` (T02 owns it) — if you need a
primitive it lacks, report it.

## Goal

The public LMSR API, in integer base units, with bounds enforcement and the
max-loss invariant verified.

## Tasks

1. `bounds.rs` — the constants from `docs/DESIGN_DECISIONS.md`, as named
   `pub const`s with doc comments explaining each:
   - `B_MIN = 10_000_000` (10 USDC)
   - `B_MAX = 1_000_000_000_000` (1,000,000 USDC)
   - `MAX_Q = 1_000_000_000_000_000`
   - `DECIMALS = 6`, `UNIT = 1_000_000`
   - `validate_b(b: u64) -> Result<()>` and `validate_q(q: u64) -> Result<()>`.
2. `error.rs` — a `LmsrError` enum: `BOutOfRange`, `QOutOfRange`,
   `InsufficientShares`, `Overflow`, `DivByZero`, `InvalidInput`. Must be
   convertible to an Anchor error code later without the crate depending on
   Anchor — a plain `#[repr(u32)]` enum with a stable discriminant is the clean
   way.
3. `lmsr.rs` — public API, all arguments and returns `u64` base units:
   - `cost(q_yes, q_no, b) -> Result<u64>`
   - `price_yes(q_yes, q_no, b) -> Result<u64>` (returns a fraction of `UNIT`,
     so `500_000` = 0.5) and `price_no(...)`
   - `buy_cost(q_yes, q_no, b, outcome, shares) -> Result<u64>` — collateral in
   - `sell_return(q_yes, q_no, b, outcome, shares) -> Result<u64>` — collateral out
   - `shares_for_cost(q_yes, q_no, b, outcome, collateral) -> Result<u64>` — the
     inverse `buy_shares` actually needs, since users spend USDC
   - `Outcome { Yes, No }` enum.
4. **Use the log-sum-exp stabilized form.** Read the last section of
   `docs/DESIGN_DECISIONS.md` before writing a line. The naive `exp(q/b)`
   formulation overflows almost immediately and is not acceptable.
5. **Match T01's rounding policy exactly.** Read `reference/README.md` — if T01
   is not finished, the policy is: cost paid by the user rounds **up**, proceeds
   returned to the user round **down**. Never round in the user's favor; the
   vault must not be drainable by repeated small trades. Document the rounding
   direction on every function.
6. `shares_for_cost` — closed-form if derivable, otherwise bisection with a
   hard iteration cap (compute budget is finite on-chain). Whichever you use,
   the result must satisfy `buy_cost(state, result) <= collateral` — assert this
   as a post-condition test.
7. Invariant tests in-crate:
   - `price_yes + price_no == UNIT` exactly (this is a hard requirement — make
     the implementation guarantee it, e.g. derive `price_no` as `UNIT − price_yes`,
     rather than hoping two independent computations agree).
   - `cost(0, 0, b) == b·ln2` within the documented tolerance, for every `b`
     across the legal range — this is the plan §1.4 max-loss bound tested under
     fixed point.
   - Buy-then-immediately-sell returns **no more** than was paid.
   - Buying moves that outcome's price up, monotonically.
   - `validate_b` rejects `B_MIN − 1` and `B_MAX + 1`.
8. `lib.rs` — re-export the public API. Crate-level docs stating the fixed-point
   format, the units, and the rounding policy.

## Definition of done

- `cargo test -p lmsr` passes in WSL.
- Public API matches plan §1.5 exactly, plus `shares_for_cost`.
- Max-loss bound verified under fixed point across the whole legal `b` range.
- `price_yes + price_no == UNIT` holds exactly, by construction.
- No panicking paths; every fallible operation returns `LmsrError`.

## Report back

The rounding policy as implemented, whether `shares_for_cost` is closed-form or
bisected (and the iteration cap), the max-loss tolerance achieved, and the
public API signatures verbatim so T07 can code against them.
