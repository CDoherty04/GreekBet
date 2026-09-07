# T04 — LMSR property, conformance, and fuzz suite

**Depends on:** T01, T03 · **Blocks:** T07
**Owns:** `crates/lmsr/tests/`, `crates/lmsr/benches/`

## Context

Plan §4.1 and §4.3. This ticket decides whether the LMSR module has met its exit
criterion: *"passes its full test suite with no known precision/overflow issues
in the expected operating range."*

You own `crates/lmsr/tests/` only. If you find a bug in `src/`, **report it —
do not fix it silently.** A test suite written by whoever fixes the bugs it
finds is worth much less.

## Tasks

**T01 is done.** `reference/vectors/` holds 3,988 cases across four files
(`grid` 2,496 · `edge` 898 · `trades` 48 sequences / 503 steps · `invariants`
546). Schema is `greekbet.lmsr.vectors.v1`, documented in `reference/README.md`.
Read that README before writing the loader — in particular, fields ending
`_exact` are 36-significant-digit decimal strings, **not** integers, and
`exceeds_max_q` / `holds` are real JSON booleans while everything else numeric
is a string.

1. **Golden-vector conformance** (`tests/conformance.rs`) — load
   `reference/vectors/*.json`, run every case through the Rust API, compare to
   the Python reference. Numeric values are JSON strings; parse to `u64`.
   - The oracle is high-precision (mpmath, 60 digits) and its integers are
     stable — T01 confirmed identical output at 120 digits. So any mismatch is
     the **Rust** side's error, not oracle noise. Treat it that way.
   - `shares_for_cost` cases carry `exceeds_max_q`; the LMSR crate returns
     unclamped values, so do not expect clamping here (T07 enforces the cap).
   - Assert a **stated absolute error bound in base units** — this is money, so
     express the tolerance as "≤ N base units", not as a relative float epsilon.
     Aim for exact equality on prices and ≤ 1 base unit on costs; if you cannot
     hit that, report the real number rather than loosening the assertion
     quietly.
   - Run `trades.json` sequences step by step and check for cumulative drift
     across a long sequence, not just per-step error.
2. **Property tests** (`tests/properties.rs`, `proptest`) over the full legal
   input space (`B_MIN..=B_MAX`, `0..=MAX_Q`):
   - `price_yes + price_no == UNIT` exactly.
   - Prices always in `[0, UNIT]`.
   - `cost` is monotonically non-decreasing in each of `q_yes`, `q_no`.
   - Buying outcome X strictly does not decrease `price(X)`.
   - **Round-trip safety:** `sell_return(buy(state, n), n) <= buy_cost(state, n)`.
     A violation here is a vault-drain bug — the single most important property
     in this suite.
   - `buy_cost(state, shares_for_cost(state, c)) <= c` (post-condition of the
     inverse).
   - **Bounded loss:** across any sequence of trades, vault collateral held is
     never less than what redemption at resolution would owe. Model this
     directly — it is plan §1.4's real-world meaning.
3. **Fuzz / boundary tests** (`tests/boundaries.rs`) — plan §4.1 asks for fuzzing
   near overflow boundaries:
   - `q` at exactly `MAX_Q`, `MAX_Q ± 1`; `b` at exactly `B_MIN`/`B_MAX` and just
     outside.
   - Maximum skew (one side `MAX_Q`, other `0`) at minimum `b` — the harshest
     input the module can legally see.
   - `u64::MAX` and `0` passed to every public function.
   - **Every case must return `Ok` or an `LmsrError`. A panic is a test failure.**
     Consider `cargo test -- --test-threads=1` plus a catch-unwind harness, or
     `cargo-fuzz` if T00's toolchain has it.
4. **Compute-unit sanity** (`benches/` or a plain measurement, your call) —
   `docs/DESIGN_DECISIONS.md` assumes Q64.64 `i128` math fits Solana's compute
   budget. Verify it rather than assuming: count operations, or build for the
   SBF target and measure. If it does not fit, that is a **major finding** —
   report it loudly, it would force a format change.
5. `crates/lmsr/tests/README.md` — what each suite covers, the tolerances
   asserted and why, and how to re-run.

## Definition of done

- `cargo test -p lmsr` runs all three suites and passes in WSL.
- Conformance covers every vector file T01 produced.
- Zero panics across the whole fuzz/boundary space.
- Compute cost measured and reported against Solana's budget.
- Every tolerance is a documented, justified number.

## Report back

Pass/fail counts per suite, the actual worst-case error observed vs the
tolerance asserted, the compute-unit measurement, and **any bug found in `src/`**
as a precise finding (inputs, expected, actual) rather than a fix.
