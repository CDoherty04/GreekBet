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
5. **Match T01's rounding policy exactly.** T01 is **done** — read
   `reference/README.md` and `reference/lmsr_ref.py`, they are the spec. The
   policy is:

   | Function | Direction |
   |---|---|
   | `cost` | floor |
   | `price_yes` | floor of `p·UNIT` |
   | `price_no` | **`UNIT − price_yes`**, defined as the complement |
   | `buy_cost` | **ceil** |
   | `sell_return` | **floor** |
   | `shares_for_cost` | floor |

   Never round in the user's favor; the vault must not be drainable by repeated
   small trades. Document the rounding direction on every function.

5a. **The trap T01 explicitly warned about — read this twice.**
   `buy_cost` and `sell_return` round the **exact trade difference once**. They
   are *not* `cost(new) − cost(old)` computed on already-rounded costs — that
   subtracts two numbers of magnitude ~1e15 and loses the answer to
   cancellation. Compute the difference cancellation-free as:

   ```
   ΔC = (m_new − m_old) + b · ln(S_new / S_old)
   ```

   where `m = max(q_yes, q_no)` (so `m_new − m_old` is an exact integer) and
   `S = Σ exp((q_i − m)/b) ∈ [1, 2]`. `reference/lmsr_ref.py` implements this;
   mirror its structure.

5b. **`shares_for_cost` has a closed form — do not bisect.** T01 derived it:

   ```
   d = (m − q_out) + X + b · ln( u_out + u_other · (1 − e^(−X/b)) )

   m = max(q_yes, q_no);  u_i = exp((q_i − m)/b);  X = collateral
   ```

   `e^(X/b)` is pulled out of the logarithm because `X/b` reaches ~1e8 at the
   domain corners and would otherwise overflow. The log argument lands in
   `(0, 2]` and every exponent is ≤ 0. Use `−expm1(−X/b)` for `1 − e^(−X/b)`.
   T01 verified this against 300 independent bisections with identical results.

5c. **Do not clamp `shares_for_cost` to `MAX_Q`.** Return the mathematical
   answer; enforcing the cap is the program's job (T07). T01's vectors flag
   these with `exceeds_max_q` — 55 such cases exist and your results must match
   them unclamped.

5d. **Zero-cost trades at extreme skew are correct, not a bug.** When
   `(q_min − q_max)/b < −138`, the exact cost of a small trade is below 1e-60
   and `ceil` gives 0. T01 deliberately did not add a `max(1, …)` floor. Match
   that. Any spam guard is T07's decision, not yours.
6. `shares_for_cost` — use the closed form in 5b. Bisection is a fallback only
   if you can demonstrate the closed form is unusable in fixed point, and it
   would need a hard iteration cap (on-chain compute is finite). Either way the
   result must satisfy `buy_cost(state, result) <= collateral` — assert this as
   a post-condition test.
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
