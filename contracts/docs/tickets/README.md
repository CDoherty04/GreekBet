# Ticket Index — LMSR + Anchor Standalone Build

11 tickets covering the whole plan. Dependencies are strict: a ticket does not
start until everything in its **Depends on** column is done.

**All 11 are done** (2026-09-09). Phase status against plan §4.3's four exit
criteria is in [`../STATUS.md`](../STATUS.md); the devnet deployment, the
transaction signatures that evidence it, and every local-vs-devnet behavioural
difference are in [`../DEVNET.md`](../DEVNET.md).

| ID | Title | Depends on | Owns (file scope) | Status |
|---|---|---|---|---|
| [T00](./T00-toolchain-bootstrap.md) | Toolchain bootstrap in WSL Ubuntu | — | `docs/TOOLCHAIN.md`, `scripts/bootstrap-wsl.sh` | **done** |
| [T01](./T01-reference-implementation.md) | Float reference impl + golden vectors | — | `reference/` | **done** |
| [T02](./T02-fixed-point-primitives.md) | Q64.64 fixed-point primitives (`exp`, `ln`) | T00 | `crates/lmsr/src/fixed.rs` | **done** |
| [T03](./T03-lmsr-core.md) | LMSR core API | T02 | `crates/lmsr/src/lmsr.rs`, `bounds.rs`, `lib.rs` | **done** |
| [T04](./T04-lmsr-test-suite.md) | Property + conformance + fuzz suite | T01, T03 | `crates/lmsr/tests/` | **done** |
| [T05](./T05-anchor-scaffold.md) | Anchor workspace + state accounts | T00 | `Anchor.toml`, `programs/greekbet/src/{lib,state,errors}.rs` | **done** |
| [T06](./T06-lifecycle-instructions.md) | `create_market` / `close_market` / `resolve_market` | T05 | `programs/greekbet/src/instructions/{create,close,resolve}_market.rs` | **done** |
| [T07](./T07-trading-instructions.md) | `buy_shares` / `sell_shares` | T04, T06 | `programs/greekbet/src/instructions/{buy,sell}_shares.rs` | **done** |
| [T08](./T08-redeem.md) | `redeem` | T06 | `programs/greekbet/src/instructions/redeem.rs` | **done** |
| [T09](./T09-local-validator-tests.md) | Local-validator lifecycle + negative tests | T07, T08 | `tests/`, `package.json` | **done** |
| [T10](./T10-devnet-integration.md) | Devnet deploy + real-USDC integration pass | T09 | `scripts/devnet/`, `tests/devnet/`, `docs/DEVNET.md`, `docs/STATUS.md` | **done** |

## Verified state, 2026-09-09

| Check | Result |
|---|---|
| `cargo test -p lmsr` | 91 passing |
| `cargo test -p greekbet --lib` | 33 passing |
| `anchor test --validator legacy --skip-build` | 44 passing, 11 pending (the devnet spec self-skipping) |
| `bash scripts/devnet/run-lifecycle.sh` | 11 passing, on Circle devnet USDC |
| Deployed program | `GRUTmtYopUczvS5m62YAvctbS9TTrbznnnj5GmFHumSZ` on devnet |

One caveat carried forward rather than closed: Circle's devnet USDC faucet is
reCAPTCHA-gated and **cannot be scripted**, so seeding the treasury with USDC is
a one-off manual step. Everything after it is automated. See
[`../STATUS.md` §3](../STATUS.md#3-devnet-lifecycle-with-real-devnet-usdc--met).

## Wave plan

```
Wave 1 (parallel)   T00 ──┐        T01 ──┐
                          │              │
Wave 2 (parallel)   T02 ──┴─► T03        │      T05 (needs T00)
                                │        │       │
Wave 3              T04 ◄───────┴────────┘       │
                                                 ▼
Wave 4 (parallel)                        T06 ──► T08
                                          │
Wave 5                            T07 ◄───┘  (also needs T04)
                                          │
Wave 6                            T09 ◄───┘
                                          │
Wave 7                            T10 ◄───┘
```

## Rules for every ticket

1. **Stay inside your file scope.** Tickets run in parallel against one worktree.
   Do not edit files owned by another ticket. If you need a change there, say so
   in your report instead of making it.
2. **Read [`docs/DESIGN_DECISIONS.md`](../DESIGN_DECISIONS.md) first.** The four
   resolved decisions are frozen.
3. **Report honestly.** If a test fails or a step was skipped, say so with the
   output. Do not report a ticket as done on unverified code.
4. **Rust work runs in WSL**, not on Windows. See `docs/TOOLCHAIN.md` for the
   invocation pattern and the `CARGO_TARGET_DIR` requirement.
