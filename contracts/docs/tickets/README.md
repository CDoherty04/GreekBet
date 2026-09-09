# Ticket Index — LMSR + Anchor Standalone Build

11 tickets covering the whole plan. Dependencies are strict: a ticket does not
start until everything in its **Depends on** column is done.

| ID | Title | Depends on | Owns (file scope) |
|---|---|---|---|
| [T00](./T00-toolchain-bootstrap.md) | Toolchain bootstrap in WSL Ubuntu | — | `docs/TOOLCHAIN.md`, `scripts/bootstrap-wsl.sh` |
| [T01](./T01-reference-implementation.md) | Float reference impl + golden vectors | — | `reference/` |
| [T02](./T02-fixed-point-primitives.md) | Q64.64 fixed-point primitives (`exp`, `ln`) | T00 | `crates/lmsr/src/fixed.rs` |
| [T03](./T03-lmsr-core.md) | LMSR core API | T02 | `crates/lmsr/src/lmsr.rs`, `bounds.rs`, `lib.rs` |
| [T04](./T04-lmsr-test-suite.md) | Property + conformance + fuzz suite | T01, T03 | `crates/lmsr/tests/` |
| [T05](./T05-anchor-scaffold.md) | Anchor workspace + state accounts | T00 | `Anchor.toml`, `programs/greekbet/src/{lib,state,errors}.rs` |
| [T06](./T06-lifecycle-instructions.md) | `create_market` / `close_market` / `resolve_market` | T05 | `programs/greekbet/src/instructions/{create,close,resolve}_market.rs` |
| [T07](./T07-trading-instructions.md) | `buy_shares` / `sell_shares` | T04, T06 | `programs/greekbet/src/instructions/{buy,sell}_shares.rs` |
| [T08](./T08-redeem.md) | `redeem` | T06 | `programs/greekbet/src/instructions/redeem.rs` |
| [T09](./T09-local-validator-tests.md) | Local-validator lifecycle + negative tests | T07, T08 | `tests/`, `package.json` |
| [T10](./T10-devnet-integration.md) | Devnet deploy + real-USDC integration pass | T09 | `scripts/devnet/`, `docs/DEVNET.md` |

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
