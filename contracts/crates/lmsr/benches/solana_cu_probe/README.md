# `solana_cu_probe` — measuring the LMSR's real compute-unit cost

Ticket T04 item 4. `docs/DESIGN_DECISIONS.md` D1 assumed Q64.64 `i128` maths
fits Solana's compute budget "well inside". This measures it instead.

Nothing here is built by `cargo build`/`cargo test`: there is no `main.rs`, so
Cargo's bench auto-discovery ignores the directory. The files are inputs to
[`run.sh`](run.sh), which assembles a throwaway workspace **outside the repo**
(`$HOME/gb-cu`), builds the probe for the SBF target and runs it under LiteSVM.
The GreekBet repo itself gains no Solana dependency.

## Why a probe program rather than a model

Counting instructions on paper is guesswork: `i128` operations lower to
`compiler-rt` calls whose cost depends on the sBPF version, and the sBPF VM
charges per executed instruction. The only honest number comes from executing
the code in the VM. So:

* `probe_lib.rs` is a Solana program whose instruction data is
  `[op, reps_lo, reps_hi, seed]`. It calls one LMSR function `reps` times.
* `harness_cu.rs` sends the same `op` with `reps = 0` and `reps = 16` and
  **differences** the `compute_units_consumed` LiteSVM reports. Entrypoint,
  account deserialisation and the compute-budget instruction are identical in
  both, so they cancel exactly.
* Linearity is checked in the same run (`reps = 1` and `reps = 4` agree with
  `reps = 16` to better than 0.1%), which is what rules out a mis-attributed
  fixed cost.

`seed` and the loop counter enter every argument, so nothing can be constant
folded or hoisted out of the loop.

## Toolchain

Exactly what `docs/TOOLCHAIN.md` pins — the numbers are only valid for it:

| | |
|---|---|
| `cargo-build-sbf` | 3.1.10, platform-tools v1.52, rustc 1.89.0 |
| arch | **`--arch v0`** (§5 of TOOLCHAIN.md: v3 does not deploy on Agave 3.1.10, and does not build here either — its `std` is not shipped with platform-tools v1.52) |
| profile | `release`, `overflow-checks = true`, `lto = "fat"`, `codegen-units = 1` — matching the workspace root |
| VM | `litesvm` 0.16 |

## Running it

```powershell
wsl -e bash -lc "bash /mnt/c/<...>/crates/lmsr/benches/solana_cu_probe/run.sh"
```

Takes ~1 minute cold (it compiles `litesvm` and the Agave crates), a couple of
seconds warm. Output goes to stdout; the script also writes
`$HOME/gb-cu/cu.out`.

## Result (2026-09-08)

| function | typical state | max skew, `b = B_MIN` |
|---|---:|---:|
| `cost` | 18,579 | 9,973 |
| `price_yes` | 12,315 | 11,933 |
| `buy_cost` | 25,732 | 12,574 |
| `sell_return` | 25,730 | 12,568 |
| `shares_for_cost` | 25,243 | **48,272** |
| `max_loss_bound` | 146 | — |
| `buy_shares`-shaped composite | **64,229** | 49,379 |

| primitive | CU |
|---|---:|
| `Fixed::exp` | 7,284 |
| `Fixed::ln` | 7,581 |
| `Fixed::expm1` | 7,333 |
| `Fixed::from_ratio` | 2,944 |

Against Solana's **200,000 CU** default per-instruction budget, and a
**1,400,000 CU** ceiling a transaction may request explicitly. Interpretation,
and the assertions that keep it honest, live in
`crates/lmsr/tests/compute_budget.rs`.

Two incidental findings from the same run:

* **`overflow-checks` is free.** Rebuilding with `overflow-checks = false`
  changed every figure by less than 0.05% — the crate already routes every
  operation through a `checked_*` call, so there is almost nothing left for the
  compiler to instrument. Keeping it on in release costs nothing.
* **Deep skew is cheaper, not dearer**, for everything except
  `shares_for_cost`: the `exp` series underflows after a couple of terms at
  `|Δq|/b = 1e8`, so the corner that stresses *precision* hardest is the one
  that stresses *compute* least.
