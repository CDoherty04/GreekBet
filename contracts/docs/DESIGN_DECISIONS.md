# Resolved Design Decisions

These were the four open items at the bottom of the build plan. All are now locked.
Changing any of them invalidates work across multiple tickets, so treat them as
frozen for this phase.

---

## D1 — Fixed-point format: **Q64.64 in `i128`**

Signed 128-bit integer, 64 integer bits, 64 fractional bits. One fixed-point unit
is `2^-64` ≈ `5.42e-20`.

**Why:** it leaves real headroom for `exp`/`ln` intermediates and for the `q/b`
ratio, and `i128` is a native Rust type available on the SBF target. Q32.32 in
`i64` (the plan's example) gives only ~`2.3e-10` resolution and a ~`2.1e9`
integer range, which gets uncomfortably tight once series terms are squared
during polynomial evaluation.

**Cost:** `i128` multiply/divide is more compute units than `i64`. A binary
market needs only a small, bounded number of `exp`/`ln` calls per instruction, so
this stays well inside Solana's per-instruction compute budget. T04 measures the
actual CU cost so the assumption is verified rather than assumed.

**Boundary rule:** all *external* quantities (`q_yes`, `q_no`, `b`, USDC amounts)
are plain `u64` base units with 6 decimals. Q64.64 is an *internal* representation
only. Conversion happens at the edge of the LMSR crate, never in the Anchor
program.

---

## D2 — Position representation: **internal `UserPosition` program state**

A PDA per `(market, user)` holding `yes_shares: u64` and `no_shares: u64`.
No SPL mints for outcome tokens.

**Why:** fewer accounts, no CPI to the token program on the hot trade path, lower
rent, and a much smaller test surface. It is sufficient for everything in this
phase's exit criteria.

**Consequence to be explicit about:** shares are **not transferable** and not
composable with other Solana programs. Secondary trading and composability are
deliberately deferred. If they are wanted later, the migration is to mint SPL
tokens against the same `q_yes`/`q_no` accounting — the LMSR core does not change.

---

## D3 — Collateral mint: **custom 6-decimal mint locally, Circle devnet USDC on devnet**

- **Local validator tests (T09):** the test suite creates its own SPL mint with
  6 decimals and mints freely to test wallets. Hermetic, fast, no faucet
  dependency, no network flake.
- **Devnet integration pass (T10):** uses Circle's devnet USDC mint
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, so ATA derivation, decimal
  handling, and transfer behavior match what a future mainnet migration would hit.

**Requirement this imposes:** the collateral mint must be a **runtime config
value**, never a hardcoded constant in the program. The `Market` account stores
its own collateral mint pubkey and every token account is validated against it.

---

## D4 — Liquidity parameter bounds: **10 USDC ≤ `b` ≤ 1,000,000 USDC**

`b` is denominated in USDC base units (6 decimals), the same unit as collateral.

| Bound | Base units | USDC | Rationale |
|---|---|---|---|
| `B_MIN` | `10_000_000` | 10 | Below this, a single small trade moves price across most of the `[0,1]` range, and fixed-point relative error on `q/b` grows sharply. |
| `B_MAX` | `1_000_000_000_000` | 1,000,000 | Max subsidy `b·ln 2` ≈ 693,147 USDC. Well inside `u64` and inside Q64.64's integer range with room to spare. |

`create_market` rejects `b` outside this range with a dedicated error.

### Companion bound on share supply

`MAX_Q = 1_000_000_000_000_000` base units (10^9 shares). Enforced on every trade
so `q_yes`/`q_no` can never approach `u64` overflow through repeated buys.

### Why overflow is structurally avoided, not just bounds-checked

The cost function is evaluated in **log-sum-exp stabilized form**:

```
m = max(q_yes, q_no)
C = m + b · ln( exp((q_yes − m)/b) + exp((q_no − m)/b) )
```

Both exponent arguments are `≤ 0`, so both `exp` calls produce values in `(0, 1]`
and **cannot overflow** regardless of how large `q` or how small `b` is. Extreme
skew underflows one term toward zero, which is the numerically correct answer
(price → 0 or 1) rather than a failure. This is the single most important
implementation constraint in the LMSR crate — the naive `exp(q/b)` form overflows
almost immediately and must not be used.
