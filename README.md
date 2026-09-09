# GreekBet

Binary YES/NO prediction markets on Solana, priced by an LMSR automated market
maker. Non-custodial: collateral lives in a per-market on-chain vault.

> **Devnet/testnet only. No real funds.** Nothing here has touched mainnet, and
> the resolver is deliberately a stubbed authority pubkey with no oracle or
> dispute logic behind it.

## Layout

```
crates/lmsr/          LMSR math. Pure Rust, no_std, ZERO dependencies, no Solana
                      types — unit-testable with a plain `cargo test`.
programs/greekbet/    The Anchor program. Treats crates/lmsr as a trusted dep.
reference/            Independent high-precision Python oracle (mpmath) plus
                      3,988 golden vectors the Rust is validated against.
tests/                TypeScript suite against solana-test-validator.
scripts/              WSL toolchain bootstrap.
docs/                 Plan, resolved design decisions, toolchain notes, tickets.
```

The split between `crates/lmsr` and `programs/greekbet` is deliberate. Fixed-point
`exp`/`ln` is the highest-risk code here, so it is isolated from Anchor entirely
and validated off-chain against an oracle before the program ever calls it.

## Build and test

Everything runs **inside WSL** (Ubuntu). Native Windows Anchor builds are not
supported.

```sh
bash scripts/bootstrap-wsl.sh        # rustup, Solana CLI, avm/Anchor, node, yarn
. ~/.greekbet-env.sh                 # PATH + CARGO_TARGET_DIR

cargo test --workspace               # 124 tests, no validator needed
yarn install
anchor build --arch v0               # --arch v0 is MANDATORY, see below
anchor test --skip-build --validator legacy   # 44 on-chain tests
```

**First build on a fresh clone:** the program keypair is gitignored and lives in
`$CARGO_TARGET_DIR/deploy/`, so your first `anchor build` mints a *different*
program id than the committed `declare_id!`. Run `anchor keys sync`, check that
it updated **both** `[programs.localnet]` and `[programs.devnet]` in
`Anchor.toml` (it only rewrites the configured cluster), then rebuild.

**Two flags that are not optional.** Anchor 1.2.0 defaults to sbpf v3, which
Agave 3.1.10 cannot load — plain `anchor build` produces an artifact that fails
with `invalid file header` on deploy and `Unsupported program id` at the
validator. `anchor test` has no `--arch` of its own, hence the two-step form.
`--validator legacy` selects `solana-test-validator`; Anchor 1.2's default,
`surfpool`, is not installed. A stale v0 `.so` in `deploy/` will make a broken
build look like it passed — wipe it if results surprise you.

Full detail, including the five failures these flags were derived from, is in
[`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md).

## Instructions

| | |
|---|---|
| `create_market` | Creator seeds the vault with the LMSR subsidy `b·ln 2` and stores the resolver pubkey |
| `buy_shares` | Deposit collateral, receive shares. `min_shares_out` floors what you get |
| `sell_shares` | Sell shares back. `min_usdc_out` floors your proceeds |
| `close_market` | Permissionless crank once `close_time` passes |
| `resolve_market` | Access-controlled state write. Stub — no oracle or dispute logic |
| `redeem` | Winning shares 1:1, losing shares zero, position cleared either way |

Slippage is enforced **on-chain** in both directions as a floor on what the
caller receives — never a price tolerance, which would be ambiguous about
*which* price (marginal-before, marginal-after, or average-paid).

## Design decisions

Frozen before coding; rationale in [`docs/DESIGN_DECISIONS.md`](docs/DESIGN_DECISIONS.md).

- **Q64.64 fixed point in `i128`.** All external quantities are `u64` 6-decimal
  base units; Q64.64 is internal only.
- **Positions are internal program state**, not SPL tokens. Shares are therefore
  non-transferable — a deliberate trade-off, with a documented migration path.
- **Collateral mint is per-market runtime config**, never a constant: a throwaway
  6-decimal mint locally, Circle's devnet USDC on devnet.
- **`10 USDC ≤ b ≤ 1,000,000 USDC`**, with `MAX_Q = 10^9` shares.

The cost function is evaluated in **log-sum-exp stabilised form**, so both
exponents stay `≤ 0` and extreme skew underflows to the correct answer. The
naive `exp(q/b)` formulation overflows around 140,000× earlier at inputs this
program legitimately reaches.

## Known findings

Deliberate and documented, not oversights.

1. **`buy_cost(shares_for_cost(c)) ≤ c` can fail by +1 base unit** — a theorem in
   exact arithmetic, false in Q64.64, on ~1 in 10,000 inputs at any skew, because
   the error in `b·ln(z)` is `b`-scaled rather than skew-scaled. `buy_shares`
   therefore charges the supplied collateral verbatim and never calls `buy_cost`
   on chain. Pinned by a characterisation test so a future fix is detectable.
2. **A near-free option exists at extreme skew.** Reaching that skew requires
   someone to have paid in proportionally, and solvency is unaffected since
   payout is bounded by `max(q_yes, q_no)`.
3. **On-chain parity covers 7 of 48 vector sequences** — there is no
   share-denominated buy instruction, so steps naming an exact share count cannot
   be expressed. The 7 span all six `b` decades; skip reasons are asserted.
4. **Vault residual after redemption is not dust.** It is `C(q) − q_win`, the
   maker's unspent subsidy. The rounding component is separately isolated: 3 base
   units over 8 trades, always in the protocol's favour.

Rounding never favours the user anywhere — cost rounds up, proceeds round down.
The alternative drains the vault over many trades, so it is property-tested.

## Status

Phase complete except devnet. Against the exit criteria in
[`docs/LMSR_ANCHOR_BUILD_PLAN.md`](docs/LMSR_ANCHOR_BUILD_PLAN.md) §4.3:

| | |
|---|---|
| LMSR module passes its full suite | **met** |
| All instructions pass local-validator lifecycle tests | **met** — 44 passing |
| Same lifecycle run once on devnet with real USDC | **not met** — ticket T10 |
| Resolver access control verified | **met** locally; devnet re-check in T10 |

Work is tracked as 11 tickets in [`docs/tickets/`](docs/tickets/).
