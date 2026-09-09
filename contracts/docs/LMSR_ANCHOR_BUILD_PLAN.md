# LMSR Module + Anchor Program — Standalone Build Plan

**Scope:** This plan covers only the LMSR pricing module and the Anchor (Solana) program implementing binary YES/NO prediction markets. The goal is a fully self-contained, independently testable unit — buyable/sellable contracts priced via AMM, settled in devnet USDC — with no dependency on a frontend, indexer, or wallet UX. Those come later, once this is proven correct on its own.

**Key decisions locked in:**
- Pricing mechanism: Automated Market Maker (LMSR), price moves based on trading activity
- Custody: Fully on-chain smart contract (non-custodial)
- Network: Solana
- Contract structure: Binary YES/NO shares
- **Environment: Testnet/devnet only — no real funds**
- Resolver: stubbed as a pluggable authority pubkey, no resolution logic built yet

---

## 1. LMSR Math Module

This is the highest-risk, most bug-prone part of the whole build — do it first, in isolation, before touching Anchor.

### 1.1 Core formulas
- Cost function: `C(q_yes, q_no) = b * ln(e^(q_yes/b) + e^(q_no/b))`
- Price of YES: `e^(q_yes/b) / (e^(q_yes/b) + e^(q_no/b))`
- Price of NO: `1 - price(YES)`
- Cost of a trade = `C(new_state) - C(old_state)`

### 1.2 Fixed-point implementation
- Solana programs have no native floating point — implement (or adopt an audited crate for) fixed-point `exp` and `ln`.
- Decide fixed-point precision (e.g., Q32.32 or similar) up front; this affects every downstream calculation.
- Implement as a **pure Rust module with no Solana/Anchor dependencies**, so it can be unit tested completely standalone, off-chain, before it's ever called from a program instruction.

### 1.3 Reference implementation for validation
- Write a parallel reference implementation in Python or JS using real floating point.
- Property-test the fixed-point module against the reference across a wide range of `b` values and share quantities, checking that price and cost calculations stay within acceptable error bounds.
- Explicitly test edge cases: `q_yes = q_no = 0` (market open, 50/50 price), heavily skewed positions, very large share counts, very small `b`.

### 1.4 Bounds and safety
- Confirm and test the max-loss bound (`b * ln(2)`) holds under the fixed-point implementation, not just the theoretical math.
- Test for integer overflow/underflow at the boundaries of expected share quantities and `b` ranges.
- Decide and document max/min allowed `b` values, and reject market creation outside that range.

### 1.5 Deliverable
- A standalone Rust crate (or module) exposing: `cost(q_yes, q_no, b)`, `price_yes(q_yes, q_no, b)`, `buy_cost(q_yes, q_no, b, outcome, amount)`, `sell_return(...)`.
- Full unit + property test suite, runnable with `cargo test`, no Solana runtime required.

---

## 2. Anchor Program

Only start this once the LMSR module is tested and stable — the program should treat it as a trusted dependency.

### 2.1 Accounts

- **`Market`** (PDA)
  - Question metadata (string or hash reference)
  - Creation timestamp / close timestamp
  - LMSR liquidity parameter `b`
  - Current YES/NO share supply (`q_yes`, `q_no`)
  - USDC vault address
  - Resolver authority pubkey (stub — no logic yet, just a stored pubkey)
  - Status enum: `Open`, `Closed`, `Resolved`
  - Winning outcome (populated once resolved)

- **`MarketVault`** — PDA-owned USDC (SPL token) account holding all collateral for the market. Program has signing authority via PDA seeds.

- **`UserPosition`** (PDA per user + market)
  - YES shares held, NO shares held
  - *Decision to make before coding:* internal program-state tracking vs. minting real SPL tokens per outcome. Internal tracking is simpler and sufficient for standalone testing; revisit transferability later if needed.

### 2.2 Instructions

| Instruction | Purpose | Notes for standalone testing |
|---|---|---|
| `create_market(question, close_time, initial_liquidity_b, resolver_pubkey)` | Creator deposits seed USDC, initializes LMSR state | `resolver_pubkey` accepted and stored, unused otherwise |
| `buy_shares(market, outcome, usdc_amount, max_slippage)` | User deposits USDC, program computes shares via LMSR cost function, credits `UserPosition` | Core path to test extensively |
| `sell_shares(market, outcome, share_amount, min_usdc_out)` | Inverse of buy; computes USDC returned, debits position, transfers from vault | Core path to test extensively |
| `close_market(market)` | Marks market closed after `close_time`, blocks further trading | Simple state transition |
| `resolve_market(market, winning_outcome)` | Sets winning outcome; callable only by stored resolver authority | **Stub only** — no dispute/vote/oracle logic, just an access-controlled state write |
| `redeem(market, position)` | Winning shares redeem 1:1 for USDC from vault; losing shares redeem for zero | Depends only on `resolve_market` having run |

Explicitly out of scope for this phase: `dispute_market`, any group/permissioning accounts, any resolver logic beyond "authority pubkey can call this one instruction."

### 2.3 Program-level design notes
- Every instruction should validate market status (e.g., reject `buy_shares` on a closed market) — build these checks in from the start since they're easy to test in isolation.
- Slippage protection (`max_slippage` / `min_usdc_out`) should be enforced on-chain, not left to the client, since this is a security-relevant guarantee independent of the rest of the app.
- Keep the resolver authority as a bare pubkey with no additional logic — this is intentionally a placeholder seam for later work, not something to build out now.

---

## 3. Testnet Setup for This Module

- Deploy to Solana **devnet** (`solana config set --url devnet`, `anchor deploy`).
- Use **Circle's devnet USDC** SPL mint if available, so integration code (ATAs, decimals, transfers) matches mainnet behavior for a future migration. A custom dummy token is an acceptable fallback if the faucet is unreliable during development.
- Keep program upgrade authority as your own keypair for fast iteration — no need to lock this down yet.
- Fund test wallets via the devnet SOL faucet plus either the USDC faucet or a `mint_test_usdc` helper script, so integration tests can run end-to-end without manual intervention each time.

---

## 4. Testing Strategy (Standalone, Pre-Integration)

### 4.1 LMSR module
- Pure Rust unit tests, no Solana runtime.
- Property tests against the floating-point reference implementation.
- Fuzz testing on inputs near overflow boundaries.

### 4.2 Anchor program
- **Local validator tests** (`solana-test-validator` + Anchor's testing framework, e.g. `anchor test` with TypeScript or Rust test clients):
  - Create a market, verify initial state and vault balance.
  - Buy shares as multiple simulated users, verify price moves as expected and matches LMSR module output exactly.
  - Sell shares, verify correct USDC returned and position debited.
  - Attempt trades after close — should fail.
  - Call `resolve_market` from a non-authority signer — should fail.
  - Call `resolve_market` from the correct authority, then `redeem` — verify winners get paid, losers get zero.
  - Slippage protection: attempt a trade with unacceptable slippage — should fail cleanly.
- **Devnet integration test pass**: repeat the above against actual devnet with real transaction latency and real (devnet) USDC transfers, to catch anything the local validator doesn't surface.

### 4.3 Exit criteria for this phase
This module is considered done and ready to integrate with the rest of the app once:
- LMSR module passes its full test suite with no known precision/overflow issues in the expected operating range.
- All Anchor instructions pass local-validator tests covering the full market lifecycle (create → trade → close → resolve → redeem).
- The same lifecycle has been run successfully at least once on devnet with real devnet USDC transfers.
- Resolver authority access control is verified (only the designated pubkey can resolve).

---

## Open Design Decisions — RESOLVED

All four blocking decisions were resolved before coding began. See
[`docs/DESIGN_DECISIONS.md`](./DESIGN_DECISIONS.md) for the full rationale.

- [x] **Fixed-point precision format** → **Q64.64 in `i128`**
- [x] **Position representation** → **Internal `UserPosition` program state** (non-transferable shares)
- [x] **Collateral mint** → **Custom 6-decimal mint for local tests, Circle devnet USDC for the devnet pass**
- [x] **Min/max allowed `b`** → **10 USDC ≤ `b` ≤ 1,000,000 USDC** (`10_000_000` … `1_000_000_000_000` base units)

---

## Execution

Work is broken into 11 tickets under [`docs/tickets/`](./tickets/), tracked in
[`docs/tickets/README.md`](./tickets/README.md). Toolchain setup is documented in
[`docs/TOOLCHAIN.md`](./TOOLCHAIN.md).
