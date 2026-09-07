# T01 — Float reference implementation + golden vectors

**Depends on:** nothing · **Blocks:** T04
**Owns:** `reference/` (exclusively)

## Context

Plan §1.3. The fixed-point Rust LMSR module (T02/T03) needs an independent
oracle to validate against. That oracle is a high-precision Python
implementation written from the formulas, not from the Rust code — it must be an
*independent* derivation, or it validates nothing.

Python 3.11.9 is available on Windows (`python`). Use it. Do not require WSL.

## Goal

A Python reference implementation plus a committed set of golden vectors that
T04 consumes to prove the Rust module correct.

## Tasks

1. `reference/lmsr_ref.py` — implement with `mpmath` at 50+ decimal digits of
   precision (falling back to `decimal` if you prefer no third-party dep; state
   which you chose):
   - `cost(q_yes, q_no, b)`
   - `price_yes(q_yes, q_no, b)` / `price_no(...)`
   - `buy_cost(q_yes, q_no, b, outcome, shares)` → collateral in
   - `sell_return(q_yes, q_no, b, outcome, shares)` → collateral out
   - `shares_for_cost(q_yes, q_no, b, outcome, collateral)` → the inverse the
     `buy_shares` instruction actually needs (user supplies USDC, gets shares).
     Solve it in closed form if you can derive it; otherwise bisect to full
     precision and say so.

   All inputs/outputs are **integers in 6-decimal base units** (`1_000_000` = 1
   USDC / 1 share), matching `docs/DESIGN_DECISIONS.md`. Convert to high-precision
   floats internally, return integers, and document the rounding direction you
   chose for each function.

2. **Rounding policy — decide it here and write it down.** It is a real
   correctness requirement, not a detail: the protocol must never round in the
   user's favor, or the vault drains over many trades. Recommended: round
   `buy_cost` and `shares_for_cost`-cost **up**, `sell_return` **down**. Whatever
   you pick, `reference/README.md` must state it and T03 must match it exactly.

3. `reference/gen_vectors.py` — emit `reference/vectors/*.json`:
   - **`grid.json`** — cross product of `b` ∈ {10, 100, 1e3, 1e4, 1e5, 1e6} USDC
     × a spread of `(q_yes, q_no)` states from balanced to extreme skew.
   - **`edge.json`** — `q_yes = q_no = 0` (must give price exactly 0.5);
     `b = B_MIN`; `b = B_MAX`; one side at `MAX_Q` with the other at 0; skews
     large enough that `exp((q_min−q_max)/b)` underflows to zero.
   - **`trades.json`** — multi-step sequences: a starting state and a list of
     buys/sells, with the expected state and cost after each step. These catch
     drift that single-shot vectors miss.
   - **`invariants.json`** — cases specifically probing `price_yes + price_no == 1`
     and the `b·ln 2` max-loss bound.

   Constants (`B_MIN`, `B_MAX`, `MAX_Q`) come from `docs/DESIGN_DECISIONS.md`.

4. JSON schema: stable, self-describing, integer values as JSON **strings** (they
   exceed the 2^53 safe-integer range and a JS consumer would silently corrupt
   them). Document the schema in `reference/README.md`.

5. `reference/test_ref.py` — sanity tests on the reference itself: prices sum to
   1, cost is monotonic in `q`, buying then selling the same amount returns
   ≤ what was paid, `C(0,0) = b·ln 2`. A broken oracle is worse than no oracle.

6. `reference/README.md` — how to run it, the rounding policy, the vector schema,
   and the precision used.

## Definition of done

- `python reference/test_ref.py` passes (or `pytest`, if you use it).
- `python reference/gen_vectors.py` regenerates all vector files deterministically.
- Vectors are committed, cover every edge case in plan §1.3, and total a
  reasonable size (aim for a few thousand cases, not a few million).

## Report back

The rounding policy you chose, whether `shares_for_cost` is closed-form or
bisected, the vector counts per file, and the JSON schema.
