# `reference/` — LMSR high-precision oracle + golden vectors

This directory is the **independent oracle** for the fixed-point Rust LMSR crate
(T02/T03). It is derived from the formulas in
[`../docs/LMSR_ANCHOR_BUILD_PLAN.md`](../docs/LMSR_ANCHOR_BUILD_PLAN.md) §1.1 and
the log-sum-exp stabilisation in
[`../docs/DESIGN_DECISIONS.md`](../docs/DESIGN_DECISIONS.md) §D4 — **not** from
the Rust implementation. Nothing here may be ported from, or "corrected" against,
`crates/lmsr/`. If the two ever disagree, that disagreement is the entire point.

| File | What it is |
|---|---|
| `lmsr_ref.py` | The oracle. Integer base units in, integer base units out, 60-digit arithmetic inside. |
| `gen_vectors.py` | Deterministic golden-vector generator → `vectors/*.json`. |
| `test_ref.py` | Self-tests on the oracle *and* on the emitted vectors. |
| `vectors/` | 3,988 committed golden cases consumed by T04. |

---

## Running it

```
python -m pip install mpmath          # once; mpmath 1.4.1 was used
python reference/test_ref.py          # 28 self-tests, exit 0 == pass
python reference/gen_vectors.py       # (re)write reference/vectors/*.json
python reference/gen_vectors.py --check   # regenerate in memory, diff vs committed
```

Windows Python 3.11.9 (`python`). No WSL required. `test_ref.py` also runs under
`pytest` — every check is a plain `test_*` function — but needs no test runner.

`--check` exits non-zero if the committed vectors drift from what the current
oracle produces, which is the guard to wire into CI.

---

## Precision

`mpmath` at **`mp.dps = 60`** (60 significant decimal digits).

The largest quantity handled is `C ≤ MAX_Q + B_MAX·ln 2 ≈ 1.0007e15`, so 60
digits leaves roughly 45 decimal digits of slack below the 1-base-unit rounding
boundary. `test_results_stable_at_higher_precision` re-runs a spread of cases at
`dps = 120` and requires every integer result to be **bit-identical**; if 60
digits were marginal, that test would fail.

`decimal` was not needed — `pip install mpmath` succeeded.

---

## Units

Every public function takes and returns plain Python `int` values in **6-decimal
base units** (`docs/DESIGN_DECISIONS.md` D1):

```
1_000_000 base units = 1 USDC = 1 share
```

Prices are in the same base units, so `500_000` means a price of 0.5 and
`1_000_000` means 1.0.

Constants, copied from `DESIGN_DECISIONS.md` D4:

```
UNIT   =             1_000_000
B_MIN  =            10_000_000     (10 USDC)
B_MAX  =     1_000_000_000_000     (1,000,000 USDC)
MAX_Q  = 1_000_000_000_000_000     (1e9 shares)
```

Inputs outside `[0, MAX_Q]` or `[B_MIN, B_MAX]` raise `ValueError`, as does
overselling (`shares > supply`) and any buy that would push `q` past `MAX_Q`.

---

## ⚠ ROUNDING POLICY — the Rust implementation must match this exactly

Money never rounds in the user's favour, or the vault drains over many trades.

| Function | Direction | Rationale |
|---|---|---|
| `cost(q_yes, q_no, b)` | **floor** (truncate) | Informational state valuation; matches the natural Q64.64 → `u64` truncation. |
| `price_yes(q_yes, q_no, b)` | **floor** of `p·UNIT` | Natural fixed-point truncation. |
| `price_no(q_yes, q_no, b)` | **`UNIT − price_yes`** | *Defined* as the complement, so `price_yes + price_no == UNIT` holds **exactly** for every input, with no ±1 drift. |
| `buy_cost(...)` | **CEIL** | User pays at least the true cost. |
| `sell_return(...)` | **FLOOR** | User receives at most the true return. |
| `shares_for_cost(...)` | **FLOOR** | User receives at most the true share count. |
| `max_loss_bound(b)` | **ceil** | It is an upper bound; rounding up keeps it valid. |

### The part that is easy to get wrong

`buy_cost` and `sell_return` round the **exact trade difference, once**. They are
**not** `cost(new) − cost(old)` computed on already-rounded costs — doing that
introduces a ±1 base-unit error in the wrong direction and breaks the round-trip
guarantee.

Concretely, both are evaluated in this cancellation-free form rather than as a
subtraction of two ~1e15-magnitude numbers:

```
ΔC = (m_new − m_old) + b·ln( S_new / S_old )
```

where `m = max(q_yes, q_no)` (so `m_new − m_old` is an **exact integer**) and
`S = e^((q_yes−m)/b) + e^((q_no−m)/b) ∈ [1, 2]`.

### What the policy buys you

`test_buy_then_sell_never_profits` (360 round trips) and
`test_sell_then_buy_never_profits` (144) confirm a user can never extract value
by immediately reversing a trade. The protocol's margin on a round trip is
**0–1 base units**, i.e. at most 0.000001 USDC — conservative but not lossy.

`test_vault_solvency_over_random_sequences` walks 1,800 random trade steps and
asserts that collateral in minus collateral out always covers the exact rise in
`C`. Tightest observed margin: `+0.0036` base units — never negative.

---

## Numerical form (D4)

The cost function is **never** evaluated as `b·ln(exp(q_yes/b) + exp(q_no/b))`.
Always:

```
m   = max(q_yes, q_no)
u_y = exp((q_yes − m) / b)     ∈ (0, 1]
u_n = exp((q_no  − m) / b)     ∈ (0, 1]
C   = m + b · ln(u_y + u_n)
```

Both exponent arguments are `≤ 0`, so neither `exp` can overflow however large
`q` is or however small `b` is. At the domain corner (`q = MAX_Q`, `b = B_MIN`)
the exponent reaches `−1e8`; the vectors include that case and the naive form
would have overflowed roughly 1e8 / 709 ≈ 140,000× earlier.

---

## API

```python
cost(q_yes, q_no, b)                            -> int    # floor
price_yes(q_yes, q_no, b)                       -> int    # floor, 0..UNIT
price_no(q_yes, q_no, b)                        -> int    # UNIT - price_yes
buy_cost(q_yes, q_no, b, outcome, shares)       -> int    # ceil
sell_return(q_yes, q_no, b, outcome, shares)    -> int    # floor
shares_for_cost(q_yes, q_no, b, outcome, coll)  -> int    # floor
max_loss_bound(b)                               -> int    # ceil(b*ln2)
```

`outcome` is the string `"yes"` or `"no"` (`lmsr_ref.YES` / `lmsr_ref.NO`).

Each function has an unrounded `*_exact` twin returning an `mpmath.mpf`
(`cost_exact`, `price_yes_exact`, `price_no_exact`, `buy_cost_exact`,
`sell_return_exact`, `shares_for_cost_exact`, `max_loss_bound_exact`) — used by
the vectors so T04 can do tolerance-based comparison instead of demanding exact
integer equality from a fixed-point implementation.

### `shares_for_cost` is **closed form**, not bisected

Solving `C(q_out + d, q_other) − C(q_out, q_other) = X` for `d`:

```
b·ln(e^((q_out+d)/b) + e^(q_other/b)) = C₀ + X
       e^((q_out+d)/b)                = e^((C₀+X)/b) − e^(q_other/b)
                                    d = b·ln( e^((C₀+X)/b) − e^(q_other/b) ) − q_out
```

Substituting the stabilised `C₀ = m + b·ln(u_out + u_other)` and factoring
`e^(m/b)` out of the bracket gives
`d = (m − q_out) + b·ln( (u_out + u_other)·e^(X/b) − u_other )`. Pulling
`e^(X/b)` out of the logarithm removes the only term that can grow without bound
(`X/b` reaches 1e8 at the corners of the domain), leaving the form actually
implemented:

```
      d = (m − q_out) + X + b · ln( u_out + u_other · (1 − e^(−X/b)) )

with  m       = max(q_yes, q_no)
      u_out   = exp((q_out   − m) / b)
      u_other = exp((q_other − m) / b)
```

The logarithm's argument now lies in `(0, 2]` and every exponent is `≤ 0`, so it
evaluates safely across the whole domain. `1 − e^(−X/b)` is computed as
`−expm1(−X/b)` so it stays accurate for tiny `X/b`.

Checks: `X = 0 → d = 0`; `q_yes = q_no = 0 → d = X + b·ln(2 − e^(−X/b))`, which
matches solving that case directly; `X/b → ∞ → d → (m − q_out) + X + b·ln S`.

`test_shares_for_cost_matches_bisection` verifies the closed form against **300
independent integer bisections of `buy_cost_exact`** — all identical, so the
derivation is confirmed, not merely asserted.

---

## Vector files

| File | Cases | Size | Contents |
|---|---:|---:|---|
| `vectors/grid.json` | 2,496 | 808 KiB | `b` ∈ {10, 100, 1e3, 1e4, 1e5, 1e6} USDC × 64 `(q_yes, q_no)` states each (balanced → 60·b skew), with a buy / sell / `shares_for_cost` probe at every state. |
| `vectors/edge.json` | 898 | 281 KiB | `q_yes = q_no = 0` (price exactly 0.5); `b = B_MIN`; `b = B_MAX`; one side at `MAX_Q` with the other at 0; an underflow ladder up to `(q_min − q_max)/b = −1e8`; 1-base-unit trades; full liquidation; buys landing exactly on `MAX_Q`. |
| `vectors/trades.json` | 48 seqs / **503 steps** | 233 KiB | 8 multi-step sequences per `b` (YES ladder, alternating flow, buy-then-unwind, collateral-denominated ladder, 1-unit dust, skewed start, 2 seeded random walks) with expected state, cost, price and running vault balance after every step. |
| `vectors/invariants.json` | 546 | 215 KiB | `price_yes + price_no == UNIT` across the full skew range, and the `b·ln 2` max-loss bound on reachable states. |
| **Total** | **3,988** | 1.5 MiB | |

Generation is deterministic: fixed input lists, a single `random.Random(20260907)`,
no timestamps, stable key order. Two runs produce byte-identical files.

---

## JSON schema

Every file is one object with the same envelope:

```jsonc
{
  "schema": "greekbet.lmsr.vectors.v1",
  "kind": "grid" | "edge" | "trades" | "invariants",
  "description": "...",
  "generated_by": "reference/gen_vectors.py",
  "reference":    "reference/lmsr_ref.py",
  "encoding": {
    "integers": "decimal strings (values exceed 2^53)",
    "exact":    "high-precision decimal strings, 36 significant digits, non-integer",
    "outcome":  "\"yes\" | \"no\""
  },
  "units":     { "decimals": 6, "unit": "1000000", "note": "..." },
  "constants": { "B_MIN": "10000000", "B_MAX": "1000000000000",
                 "MAX_Q": "1000000000000000", "UNIT": "1000000" },
  "precision": { "library": "mpmath", "version": "1.4.1", "dps": 60,
                 "form": "log-sum-exp stabilised" },
  "rounding":  { "cost": "floor", "price_yes": "floor", "price_no": "complement",
                 "buy_cost": "ceil", "sell_return": "floor",
                 "shares_for_cost": "floor", "note": "..." },
  "count": 2496,
  "cases": [ /* `count` case objects */ ]
}
```

### Encoding rules

- **All integer quantities are JSON *strings***. `q` reaches `1e15` and `cost`
  reaches `~1.0007e15`, both past the `2^53` exact range of a JSON double; a JS
  consumer reading them as numbers would silently corrupt them. Parse with
  `u64::from_str` / `BigInt`, never `as f64`.
- Fields ending in **`_exact`** are high-precision decimal strings with 36
  significant digits and are **not** integers (they may be `"0.5"`,
  `"7.12e-218"`, …). They exist for tolerance-based comparison against a
  fixed-point implementation. Parse as decimal/float.
- `exceeds_max_q` and `holds` are real JSON booleans.
- `collateral_in_for_shares` is `null` when not applicable (see below).

### Case objects

Every case has `"id"` (unique within its file, e.g. `"grid-00001"`) and
`"type"`. `type` is the discriminant.

**`state`** — also emitted as `state_market_open`, `state_b_bound`,
`state_max_q`, `state_underflow_skew` in `edge.json`; identical field set, the
suffix only says *why* the case is there.

| field | kind | meaning |
|---|---|---|
| `b`, `q_yes`, `q_no` | int-str | input state |
| `cost` | int-str | `cost()`, floored |
| `cost_exact` | dec-str | unrounded `C` |
| `price_yes`, `price_no` | int-str | base units; always sum to `1000000` |
| `price_yes_exact` | dec-str | fraction in `[0, 1]` |

**`buy`**

| field | kind | meaning |
|---|---|---|
| `b`, `q_yes`, `q_no` | int-str | state before |
| `outcome` | `"yes"`/`"no"` | side bought |
| `shares` | int-str | shares bought |
| `collateral_in` | int-str | `buy_cost()`, **ceiled** |
| `collateral_in_exact` | dec-str | unrounded |
| `q_yes_after`, `q_no_after` | int-str | state after |

**`sell`** — same shape with `collateral_out` / `collateral_out_exact`
(**floored**).

**`shares_for_cost`**

| field | kind | meaning |
|---|---|---|
| `b`, `q_yes`, `q_no`, `outcome` | | state + side |
| `collateral` | int-str | collateral spent |
| `shares` | int-str | `shares_for_cost()`, **floored** |
| `shares_exact` | dec-str | unrounded |
| `exceeds_max_q` | bool | `true` if `supply + shares > MAX_Q`, i.e. the *program* must reject this trade even though the math is well defined |
| `collateral_in_for_shares` | int-str \| null | `buy_cost()` of `shares`; **always ≤ `collateral`**. `null` when `exceeds_max_q`. |

**`sequence`** (`trades.json` only)

| field | kind | meaning |
|---|---|---|
| `name` | str | e.g. `"buy_then_unwind"` |
| `b`, `q_yes`, `q_no` | int-str | initial state |
| `cost_initial` | int-str | `cost()` of the initial state |
| `step_count` | number | `len(steps)` |
| `steps` | array | ordered steps |

Each step:

| field | kind | meaning |
|---|---|---|
| `index` | number | 0-based, contiguous |
| `op` | str | `"buy"` \| `"sell"` \| `"buy_with_collateral"` |
| `outcome` | `"yes"`/`"no"` | |
| `shares` | int-str | shares moved (an *output* for `buy_with_collateral`) |
| `collateral` | int-str | present only for `buy_with_collateral`: the input spend |
| `shares_exact` | dec-str | present only for `buy_with_collateral` |
| `collateral_in` / `collateral_out` | int-str | exactly one of the two |
| `collateral_in_exact` / `collateral_out_exact` | dec-str | present for `buy` / `sell` |
| `q_yes_after`, `q_no_after` | int-str | state after this step |
| `cost_after` | int-str | `cost()` of that state |
| `price_yes_after` | int-str | `price_yes()` of that state |
| `net_collateral_after` | int-str | running Σ in − Σ out |
| `solvency_margin_exact` | dec-str | `net_collateral_after − (C(state) − C(initial))`; **must never be negative** |

**`max_loss_constant`** (`invariants.json`) — `b`, `max_loss_bound`,
`max_loss_bound_exact`, `cost_at_origin`, `cost_at_origin_exact`.

**`price_sum`** (`invariants.json`) — `b`, `q_yes`, `q_no`, `price_yes`,
`price_no`, `price_sum` (always `"1000000"`), `price_yes_exact`,
`price_no_exact`.

**`max_loss`** (`invariants.json`) — `b`, `q_yes`, `q_no`, `cost`,
`cost_at_origin`, `collateral_collected_exact`, `payout_yes`, `payout_no`,
`loss_if_yes_exact`, `loss_if_no_exact`, `max_loss_bound`, `holds` (always
`true`).

---

## Behaviours T04/T07 should expect (not bugs)

1. **Zero-cost trades exist at extreme skew.** Buying the near-worthless side
   when `(q_min − q_max)/b < −138` costs 0 base units, because the exact cost is
   below `1e-60` — genuine LMSR behaviour, not a precision artefact. The `b·ln 2`
   bound still holds at every such state (`test_max_loss_bound_holds`), so it is
   not a solvency issue. `buy_cost` is a pure `ceil`, with no `max(1, …)` floor;
   if the program wants a "nonzero cost" spam guard it belongs in `buy_shares`
   (T07), not in the LMSR core, and it would be a deliberate deviation from this
   oracle.
2. **`shares_for_cost` is not clamped to `MAX_Q`.** At extreme skew the worthless
   side is nearly free, so a spend can buy more shares than the protocol allows
   to exist — e.g. `edge-00897`: `q_yes = MAX_Q`, `b = B_MAX`, spend 100,000,000
   USDC on NO → 1,099,999,999,999,999 base units of NO, 10% past `MAX_Q`. Even
   1 USDC at `q_yes = MAX_Q`, `b = B_MIN` buys 999,999,977,478,315 base units.
   The oracle returns the mathematical answer and sets `exceeds_max_q`;
   enforcing the cap is the program's job. **55 vector cases carry the flag**
   (36 of them with room still left on that side, i.e. genuinely oversized
   results rather than a full book).
3. **`price_no` is the complement, not an independent computation.** Computing
   both sides independently and truncating each would let the pair sum to
   `999_999`. Rust must derive `price_no` as `UNIT − price_yes`.
4. **At `q_yes = MAX_Q, b = B_MIN`, `cost` is exactly `q_yes` and `price_yes` is
   exactly `UNIT`.** `exp(−1e8)` underflows every representable format; that is
   the correct limit, and the corresponding vectors assert it.

---

## Self-test inventory

`python reference/test_ref.py` → 28 tests, all passing.

Oracle correctness: prices sum to 1 (504 states) · balanced price exactly 0.5 ·
price monotone in `q_yes` · price is `dC/dq_yes` (central difference) ·
`C(0,0) == b·ln 2` · cost monotone · cost bracketed by `[max q, max q + b·ln2]` ·
cost symmetric · trade form agrees with `C(new) − C(old)` · zero-amount trades
return exactly 0 · buy→sell and sell→buy never profit · `buy_cost ∈ [p₀·s, s]` ·
`sell_return ∈ [0, s]` · out-of-bounds inputs rejected · **closed-form
`shares_for_cost` == independent bisection** · inverse never overspends and is
tight · inverse monotone · `b·ln 2` bound holds · 1,800-step random-walk vault
solvency · results identical at `dps` 60 and 120.

Vector integrity: envelope well-formed and every integer field a parseable
string (4,491 objects) · all `q`/`b` inside the declared domain · every priced
case sums to `UNIT` (828) · market-open cases price exactly 0.5 · every
`shares_for_cost` case affordable (1,039, plus 55 flagged) · every sequence's
running balance reconciles and stays solvent (503 steps) · every `max_loss` case
within `b·ln 2` (256).
