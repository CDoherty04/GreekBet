# `crates/lmsr/tests/` — the T04 suite

This directory is the exit criterion for plan §4.3's first bullet: *"the LMSR
module passes its full test suite with no known precision/overflow issues in the
expected operating range."*

It was written by T04, which owns **only** `tests/` and `benches/`. It does not
own `src/` and did not change it. Where the suite found something worth knowing
about `src/`, that is reported, not patched — a suite written by whoever fixes
the bugs it finds is worth much less.

---

## The suites

| file | what it proves | cases |
|---|---|---:|
| [`conformance.rs`](conformance.rs) | the crate agrees with the independent 60-digit `mpmath` oracle on every committed golden vector | 3,988 vectors → **7,135 comparisons** |
| [`properties.rs`](properties.rs) | the invariants hold at *every* point of the legal domain, not only at the chosen ones (`proptest`) | 21 tests, **~24,600 generated cases + a 120,000-case sweep** |
| [`boundaries.rs`](boundaries.rs) | no input — legal, illegal or absurd — can make a public function panic | **~1.9M calls** |
| [`fixed_exp_positive.rs`](fixed_exp_positive.rs) | the `x > 0` branch of `Fixed::exp`, which T02 never characterised and T03 put on the hot path | 320 + 144 golden points, 43,600-point sweep |
| [`compute_budget.rs`](compute_budget.rs) | the measured Solana compute-unit cost, against the 200,000 CU budget | recorded measurement + budget arithmetic |
| [`common/mod.rs`](common/mod.rs) | shared helpers: a dependency-free JSON reader, exact decimal parsing, skew bookkeeping | — |

Supporting files:

* [`data/exp_positive_golden.rs`](data/exp_positive_golden.rs) — generated table,
  **do not hand-edit**; regenerate with
  [`gen_exp_positive_golden.py`](gen_exp_positive_golden.py).
* [`../benches/compute_units.rs`](../benches/compute_units.rs) — native timings
  next to the on-chain figures.
* [`../benches/solana_cu_probe/`](../benches/solana_cu_probe/) — the SBF probe
  program and LiteSVM harness that produced those figures, plus `run.sh`.

### Why `common/mod.rs` parses JSON by hand

The `lmsr` crate is deliberately dependency-free so it builds for the SBF
target. Adding `serde_json` purely to read four fixture files would put a
transitive dependency tree behind every `cargo test`. The parser is ~200 lines
and reads exactly the subset `reference/gen_vectors.py` emits.

It also has to be careful about the encoding, which is documented in
`reference/README.md`:

* every integer field is a **decimal string** (`q` reaches `1e15`, `cost`
  `~1.0007e15`, both past `2^53` — an `f64` round trip would corrupt them);
* fields ending `_exact` are **36-significant-digit decimals**, not integers,
  and can be as small as `7.12e-218`. `Dec` carries them as an `i128` scaled by
  `10^12`, i.e. `1e-12`-base-unit resolution over `±1.7e26` base units — six
  orders of magnitude finer and eleven wider than anything the LMSR domain can
  produce, so no measurement below is limited by the helper;
* `exceeds_max_q` and `holds` are real JSON booleans.

---

## Running it

```sh
# everything (WSL — see docs/TOOLCHAIN.md; native Windows is not supported)
cargo test -p lmsr

# one suite, with the measurement tables printed
cargo test -p lmsr --test conformance        -- --nocapture
cargo test -p lmsr --test fixed_exp_positive -- --nocapture
cargo test -p lmsr --test compute_budget     -- --nocapture
cargo test -p lmsr --test boundaries         -- --nocapture

# the release profile too: it optimises differently, and the workspace root
# keeps overflow-checks on there, so it is a genuinely different run
cargo test -p lmsr --release

# more property cases than the file's own configuration
PROPTEST_CASES=50000 cargo test -p lmsr --test properties

# native cost profile
cargo bench -p lmsr

# re-measure the on-chain compute cost (needs the Solana toolchain)
bash crates/lmsr/benches/solana_cu_probe/run.sh

# regenerate the positive-exp golden table (Windows CPython + mpmath)
python crates/lmsr/tests/gen_exp_positive_golden.py
```

Nothing here needs a network, a validator or a keypair except
`solana_cu_probe/run.sh`, which builds for the SBF target and runs LiteSVM
in-process.

---

## Every tolerance asserted, and why

**No tolerance in this directory is a relative float epsilon.** This is money:
every bound on a monetary quantity is an integer count of base units
(`1_000_000` base units = 1 USDC = 1 share). Float bounds appear only where the
quantity being bounded is itself dimensionless — the relative error of `exp`.

### 1. Conformance: exact below skew 48, ≤ 1 base unit above it

Let `skew = |q_yes − q_no| / b`.

| regime | asserted |
|---|---|
| `skew < 48` (`EXACT_SKEW_LIMIT`) | **exact integer equality** |
| `skew ≥ 48` | **≤ 1 base unit** (`1e-6` USDC) |

This is not a fudge factor, it is a statement about the format. One Q64.64 ulp
is `2^-64 ≈ 5.42e-20`. The minority weight in the log-sum-exp form is `e^−skew`,
which drops below half an ulp at `skew ≈ 45` — and, after the pre-scaling in
`lmsr::b_small_softplus`, at `45 + ln b`. `mpmath` at 60 digits still carries
that weight; Q64.64 cannot. Past the cliff the two arithmetics can legitimately
land on opposite sides of an integer boundary, one base unit apart. Below the
cliff there is nothing to disagree about, so equality is demanded.

`lmsr.rs` asserts the same threshold internally as its own `EXACT_SKEW_LIMIT`,
and T03 measured the first real disagreement at skew **59** — an 11-unit margin
below the asserted limit.

Both halves are hard failures with the case id, both values and the skew in the
message. A gap `> 1` base unit, or **any** gap below skew 48, is a genuine
finding — widen nothing.

> **`EXACT_SKEW_LIMIT` describes the corpus, not the function.** All 7,135
> comparisons honour the split and the lowest disagreeing skew is 59 — but that
> is a fact about these 3,988 vectors. The real error bound on `b·ln(z)` is
> `≈ b · 2^-64 · k`, bounded by `b`, **not** by skew; whenever the exact answer
> lands that close below an integer, `ceil` flips at any skew.
> `properties.rs` found exactly that at **skew 10.5** — see §11 below. This
> suite's exactness assertion is a regression guard on a fixed corpus, and
> nothing downstream should read it as a guarantee about arbitrary inputs.

A trade spans two states; the guard is evaluated at the **more skewed** of the
pair, because exactness can only be demanded when every state involved is inside
the exact range.

### 2. Conformance: the totals are pinned

Per-case tolerance is not enough — a regression could stay inside `±1`
everywhere and still be a regression. So `conformance.rs` also pins:

* `TOTAL_COMPARISONS = 7_135` — coverage cannot silently shrink;
* `TOTAL_DISAGREEMENTS = 105` — the count cannot grow;
* `LOWEST_DISAGREEING_SKEW = 59.0` — disagreements cannot migrate *down* the
  skew scale even while staying above 48;
* `3_988` cases across the four files.

**Measured, 2026-09-08:**

| function | comparisons | disagreements | lowest bad skew |
|---|---:|---:|---:|
| `cost` | 1,361 | **0** | — |
| `price_yes` | 1,331 | 36 | 59.00 |
| `price_no` | 828 | 30 | 59.00 |
| `buy_cost` | 1,249 | 4 | 59.75 |
| `sell_return` | 890 | 1 | 92.00 |
| `shares_for_cost` | 1,212 | 34 | 500.00 |
| `max_loss_bound` | 264 | **0** | — |
| **total** | **7,135** | **105** (1.47%) | **59.00** |

Worst observed `|delta|`: **1 base unit**, against a tolerance of 1.

T03 reported 75. The 30 extra are `price_no`, which T03 did not count
separately; since `price_no` is *defined* as `UNIT − price_yes` it cannot
disagree independently, and the five functions T03 counted give
`36 + 4 + 1 + 34 = 75`, identical.

### 3. Conformance: rounding direction, exactly

Independent of the oracle's integers, each trade is checked against its own
unrounded `*_exact` value:

* `buy_cost >= ceil(exact)` — the user is never charged less than the true cost;
* `sell_return <= floor(exact)` — the user is never paid more than the true
  return.

Tolerance: **zero**. These are what stop the vault leaking a base unit per
trade.

### 4. Conformance: cumulative drift over `trades.json`

Each of the 48 sequences (503 steps) is replayed **twice**:

* **locked** to the oracle's states, comparing each step's outputs — catches
  per-step error;
* **free**, feeding Rust's own `shares_for_cost` answers back into the state so
  divergence compounds — catches cumulative drift.

Asserted on the locked run: the running vault balance never drifts from the
oracle's by more than **1 base unit per step elapsed**. Measured over 503 steps:
the balances stay identical.

Asserted on the free run, after **every** step: collateral held covers the rise
in the cost function, `net >= C(now) − C(initial) − 1`. The single base unit is
not slack for error — both costs are `floor`s, so the integer margin can sit one
below the exact one. **Measured worst margin: 0.**

### 5. Properties: the two vault-drain vectors

| property | tolerance |
|---|---|
| `sell_return(buy(state, n), n) <= buy_cost(state, n)` | **0 base units** |
| `buy_cost(sell(state, n), n) >= sell_return(state, n)` | **0 base units** |
| vault `>= max(q_yes, q_no)` after every step of an arbitrary sequence | **0 base units** |
| `buy_cost(state, shares_for_cost(state, c)) <= c` | **+1 base unit** — see §11 |

Zero, in every case that concerns the vault. Any slack in the first is free
money that can be looped until the vault is empty; slack in the third is
insolvency. The fourth is the one finding this suite made and is written up
below. The bounded-loss
model is the real-world one: the maker seeds the vault with
`max_loss_bound(b) = ceil(b · ln 2)`, buys pay in, sells pay out, and at
resolution the winning side is redeemed at one collateral unit per share, so the
obligation is `max(q_yes, q_no)` whichever way it resolves.

### 6. Properties: the one place a base unit is allowed

`trade_deltas_agree_with_the_difference_of_costs` checks the cancellation-free
trade form against the naive `cost(new) − cost(old)`. The bound is **derived,
not tuned**: with `ΔC` the exact difference,
`ceil(ΔC) − (floor(C₁) − floor(C₀)) ∈ {0, 1}` and
`floor(ΔC′) − (floor(C₀) − floor(C₁)) ∈ {−1, 0}` from the rounding alone; one
extra base unit each way absorbs the deep-skew `±1` measured in §1. Asserted
`[−1, +2]` for buys and `[−2, +1]` for sells.

### 7. Properties: exact structural facts

`price_yes + price_no == UNIT` — exactly, no drift. Prices in `[0, UNIT]`.
`cost` monotone non-decreasing in each `q` **as an integer**, which is stronger
than monotonicity of the real-valued function and is what the program relies on.
`cost` symmetric. `max(q) <= C <= max(q) + ceil(b·ln 2)`. Buying an outcome
never lowers its price. Zero-size trades cost exactly zero.

Domain: every out-of-range input returns the documented `LmsrError` variant —
`QOutOfRange`, `BOutOfRange`, `InsufficientShares` — and every in-range input
returns `Ok`. There is no third outcome.

### 8. Boundaries: no tolerance at all

The contract is structural: **every input returns `Ok(_)` or
`Err(LmsrError)`; a panic is a failure.** Every call goes through
`common::catch`, so an escaped `unwrap`, a slice index or an arithmetic
overflow surfaces as a named case rather than a dead test binary.

`overflow-checks` is on in *both* profiles (dev by default, release because the
workspace root re-enables it), so a wrapping subtraction panics here rather than
silently returning a wrong answer. **Run the suite both ways.**

Coverage: a cartesian grid of `q × q × b × outcome × n` over
`{0, 1, 2, UNIT±1, MAX_Q±2, 2^62, 2^63±1, u64::MAX±1}` and
`{0, 1, UNIT, B_MIN±1, B_MAX±1, MAX_Q, 2^63, u64::MAX±1}`; `0` and `u64::MAX`
into every argument position of every function explicitly; the harshest legal
input (`q = MAX_Q`, other side `0`, `b = B_MIN` — skew `1e8`); 200,000
pseudorandom cases drawn from the whole `u64` range; and the `fixed` layer at
`i128::MIN`/`i128::MAX` and the exact `exp` cut-offs.

**Measured: 1,878,000 calls, 0 panics.**

The one place exact values are asserted is `the_harshest_legal_input`, where
they are mathematical limits: `cost(MAX_Q, 0, B_MIN) == MAX_Q`,
`price_yes == UNIT`, `price_no == 0`, and 1 USDC on the worthless side buys
exactly `999,999,977,478,315` base units (the figure `reference/README.md` §2
quotes).

### 9. `Fixed::exp` on `x > 0` — the gap T04 was asked to close

T02 characterised `exp` only on `x ≤ 0`, and `fixed.rs`'s header says T03 would
never need the positive branch. **That stopped being true.** T03's
`b_small_softplus` evaluates `b · e^x` as `exp(ln b + x)`, which is positive
whenever `x > −ln b` and reaches `ln(1e12) − 20 = +7.63102…` at `b = B_MAX`. So
the branch is on the hot path of every deeply skewed `cost`, `buy_cost`,
`sell_return` and `shares_for_cost`, and the 128-point table in `src/fixed.rs`
contains not one point of it.

The bound is stated as a **relative** error here, unlike T02's absolute ulp
counts, because the algorithm's structure makes it so: `exp` evaluates
`e^-r ∈ [1/2, 1]` and then shifts left by `n+1`, which multiplies the series'
~2 ulp by `2^(n+1)`. An absolute count would read "10^19 ulp" and mean nothing.

| table | domain | **measured** | asserted |
|---|---|---|---|
| `exp(x)` | `(0, 7.7]` — reachable band | **2.8149e-19** at `x = 7.222` | ≤ 1.0e-18 |
| `exp(x)` | `(0, 43.67)` — whole branch | **7.3489e-19** at `x = 43` | ≤ 3.0e-18 |
| `exp(ln b + x)` vs `b·e^x` | the real `b_small_softplus` inputs | **2.8842e-18** at `b = 1e10, x = −27` | ≤ 6.0e-18 |
| same, absolute | | **1.454e-15 base units** | < 1e-9 base units |

**The positive branch is as accurate as the negative one.** `2.81e-19` is within
30% of the `2.17e-19` T02 measured for `x ≤ 0`. The `2.88e-18` composite outlier
is not algorithmic: the result there has magnitude `0.0188`, where a single raw
ulp *is* `2.9e-18` relative — the fixed-point floor, not an error in `exp`.

The figure that matters is the absolute one. The scaled softplus term carries at
most **1.454e-15 base units** of error against a **1**-base-unit rounding step:
fifteen orders of magnitude of margin, so this branch provably cannot move a
rounded result.

Also asserted: monotonicity across 43,600 consecutive positive arguments; every
multiple of the hard-coded `LN_2_RAW` and both of its neighbours (the range
reduction's seams, where a split bug would show and nowhere else); and that the
overflow edge sits at `ln(2^63) = 43.668`, returning `Overflow` above it rather
than wrapping.

### 10. Compute units — measured, not modelled

Full detail in [`compute_budget.rs`](compute_budget.rs) and
[`../benches/solana_cu_probe/README.md`](../benches/solana_cu_probe/README.md).

| | CU | % of the 200,000 default |
|---|---:|---:|
| `buy_shares`-shaped sequence, measured in the VM | **64,229** | 32% |
| same, worst-column upper bound | **86,319** | 43% |
| `shares_for_cost` at max skew — the single dearest call | **48,272** | 24% |
| `Fixed::exp` / `Fixed::ln` | 7,284 / 7,581 | — |

**Q64.64 fits; no format change is needed.** But the headroom on the hot path is
2.3×, not 100×, so `compute_budget.rs` asserts a **100,000 CU ceiling** — half
the default budget — on the LMSR maths of any one instruction, leaving the rest
for Anchor and the SPL token CPI. Two `shares_for_cost`-class calls fit that
ceiling; three do not, and the test says so.

`overflow-checks` turns out to be **free** (< 0.05% on every figure), because
the crate already routes every operation through a `checked_*` call.

### 11. The one finding: `buy_cost` can be `+1` at any skew

**Reported, not fixed.** T04 owns `tests/`, not `src/`.

`buy_cost(state, shares_for_cost(state, c)) <= c` is stated without
qualification in two places — `lmsr.rs` ("`buy_cost` of every
`shares_for_cost` answer is affordable — 0 failures in 1,212") and
`reference/README.md` ("`collateral_in_for_shares` … **always ≤
`collateral`**"). In exact arithmetic it is a theorem: `shares_for_cost`
*floors* the exact `d`, so `n ≤ d`, so `buy_cost_exact(n) ≤ c`, and `ceil` of
something `≤` an integer `c` is `≤ c`.

The Rust implementation violates it by exactly `+1` base unit on roughly
**1 in 10,000** randomly drawn `(state, budget)` pairs, at every `b` decade,
down to **skew 10.5** — well inside the range where `EXACT_SKEW_LIMIT` claims
exactness. Three counterexamples, each checked against `reference/lmsr_ref.py`:

| `q_yes` | `q_no` | `b` | side | shares | exact `ΔC` | correct | **Rust** | skew |
|---:|---:|---:|---|---:|---|---:|---:|---:|
| 48 | 10,527,565,366,593 | 999,863,744,567 | Yes | 74,075,393,532 | `2056657.99999997722` | 2,056,658 | **2,056,659** | **10.53** |
| 3,725 | 7,914,733,172,682 | 494,421,819,072 | Yes | 474,415,672,255 | `88887.999999997326` | 88,888 | **88,889** | **16.01** |
| 2,439,435,913,643 | 0 | 38,240,627,043 | No | 1,718,147,600,825 | `245.99999999985777` | 246 | **247** | 63.79 |

In all three the oracle and Rust agree on `shares_for_cost` exactly; the `+1` is
in **`buy_cost`**.

**Root cause — inherent, not a coding mistake.** `buy_cost` evaluates
`ΔC = (m₁ − m₀) + b·ln(S₁/S₀)`, and `lmsr.rs`'s own precision note says
`b·ln(z)` carries an absolute error of about `b · abs_err(z)/z`, "under `1e-6`
base units even at `b = B_MAX`". At `b ≈ 1e12` that is `≈ 2.7e-8`. Whenever the
exact `ΔC` lands within that distance *below* an integer — as all three cases do
— `ceil` rounds to the wrong side. The bound is `b`-scaled, **not** skew-scaled,
so it bites at any skew; the observed rate simply tracks the error magnitude.

**Impact.** None on solvency: the error is `+1` in the *protocol's* favour, and
the round trip is unaffected — 6,000,000 sampled buy-then-sell round trips gave
0 violations and a minimum margin of 0. The consequence is for **T07**:
`buy_shares` must not be written as *"quote `n = shares_for_cost(c)`, charge
`buy_cost(n)`, assert the charge is `≤ c`"* — that assertion fails about once in
ten thousand trades and the instruction would revert on a legitimate input.
Charging exactly `c`, which is what `reference/vectors/trades.json`'s
`buy_with_collateral` ledger does, has no such problem.

Encoded as `properties::the_inverse_can_overspend_by_one_base_unit` (the three
cases pinned, so a future fix is detectable) and
`properties::the_overspend_is_always_exactly_one_base_unit` (a deterministic
120,000-case sweep asserting the `+1` is never exceeded).

---

## What this suite does *not* cover

* **On-chain behaviour.** No Anchor accounts, PDAs, CPIs or authority checks —
  that is T09. The only on-chain thing here is the compute-unit probe, and it
  lives outside the repo.
* **The `MAX_Q` cap on `shares_for_cost`.** The crate deliberately returns the
  unclamped mathematical answer (`reference/README.md` §2); enforcing the cap is
  T07's job. The suite asserts the crate stays unclamped and that `buy_cost`
  refuses the oversized result.
* **The oracle itself.** `reference/test_ref.py` self-tests it; this suite
  treats it as ground truth, which is what T01 established.
* **Re-measuring compute units in CI.** `cargo test` has no Solana VM. The
  figures are recorded constants with a documented, one-command reproduction.
