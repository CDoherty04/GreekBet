# T09 — Local-validator lifecycle and negative tests

**Depends on:** T07, T08 · **Blocks:** T10
**Owns:** `tests/`, `package.json`, `tsconfig.json`, `Anchor.toml` `[scripts]` section

## Context

Plan §4.2, first half. This ticket decides the second exit criterion: *"All
Anchor instructions pass local-validator tests covering the full market lifecycle
(create → trade → close → resolve → redeem)."*

`docs/DESIGN_DECISIONS.md` D3: local tests create their **own 6-decimal SPL
mint** and mint freely. No faucet, no network, hermetic.

You own the tests. If you find a bug in the program, **report it — do not fix
it.** Note that Node and yarn must be the **WSL-side** installs (T00), not the
Windows ones.

## Build environment — read `docs/TOOLCHAIN.md` before running anything

T00 established these; each one will otherwise cost you an hour of confusing
failures:

- **The build/test sequence is `anchor build --arch v0` then
  `anchor test --skip-build --validator legacy`.** Anchor 1.2.0 defaults to
  sbpf v3, which Agave 3.1.10 refuses to load (`Unsupported program id` /
  `Program is not deployed` at the validator). `anchor test` accepts no `--arch`
  of its own, and `anchor test -- --arch v0` errors with "provided more than
  once", so the two-step form is the only one that works.
- **`--validator legacy` is required.** Anchor 1.2 defaults to `surfpool`, which
  is not installed — without the flag `anchor test` fails instantly. Do not
  install surfpool; this ticket wants `solana-test-validator`.
- **Trap T00 hit directly:** a stale v0 `.so` in `deploy/` makes a broken v3
  build look like it passed. If results seem impossibly good, wipe `deploy/`
  and rebuild.
- **`./target` is a symlink** to `$CARGO_TARGET_DIR` (`~/.cache/greekbet-target`),
  because Anchor honors that variable and writes nothing into the workspace.
  `ts-mocha` is transpile-only so tests pass regardless, but `tsc` and editors
  need the symlink to resolve `../target/types/greekbet`. Recreate it with
  `ln -sfn "$CARGO_TARGET_DIR" <workspace>/target` if it goes missing.
- **Node and yarn must be the WSL installs** (`~/.nvm/…/v24.20.0`, yarn 1.22.22).
  Windows `npm` leaks into WSL via interop with no matching `node`;
  `~/.greekbet-env.sh` prepends nvm's bin so the Linux one wins. Source it.
- Cold `anchor build` ~10 min, warm 4–22 s. Do not abandon on a timeout.

## Tasks

1. Set up the TS test harness (`@coral-xyz/anchor`, `@solana/spl-token`, mocha,
   chai, ts-node) so `anchor test` runs against a local validator.
2. Shared fixture helpers in `tests/utils.ts`: create the 6-decimal mint, fund
   and airdrop wallets, mint collateral, derive all PDAs, read account state.
3. **Happy-path lifecycle** (`tests/lifecycle.ts`) — plan §4.2, in order:
   - Create a market; assert initial state and that the vault holds exactly the
     `b·ln 2` seed.
   - Buy YES as user A; assert shares credited, `q_yes` moved, vault balance up
     by exactly the USDC paid.
   - Buy NO as user B; assert prices moved the expected direction.
   - Buy more YES as user C; assert `price_yes` rose monotonically across the
     three trades.
   - Sell part of A's position; assert USDC returned and position debited.
   - Warp past `close_time` and call `close_market`.
   - `resolve_market` as the resolver with YES winning.
   - `redeem` for A and C (winners, paid 1:1) and B (loser, paid zero).
   - **Assert vault solvency at every step**, and that the vault is fully drained
     (± dust from documented rounding) after all redemptions. Report any residual.
4. **LMSR parity** (`tests/parity.ts`) — plan §4.2 requires on-chain results
   *"match LMSR module output exactly."* Load `reference/vectors/trades.json`,
   replay sequences on-chain, and assert exact equality with the reference. This
   is the strongest test in the suite; do not weaken it to a tolerance without
   reporting why.
5. **Negative tests** (`tests/negative.ts`) — every one must fail with the
   *specific* expected error code, not merely fail:
   - Buy and sell after `close_market` → `MarketNotOpen`.
   - `resolve_market` from a non-authority signer → `Unauthorized`.
   - `resolve_market` before `close_market` → `MarketNotClosed`.
   - `resolve_market` twice → `MarketAlreadyResolved`.
   - Buy with unsatisfiable slippage → `SlippageExceeded` (clean failure, no
     state change — assert state is unchanged afterward).
   - Sell with `min_usdc_out` above achievable → `SlippageExceeded`.
   - Sell more shares than held → `InsufficientShares`.
   - `create_market` with `b` below `B_MIN` and above `B_MAX` → `BOutOfRange`.
   - `create_market` with `close_time` in the past → `CloseTimeInPast`.
   - `close_market` before `close_time` → `CloseTimeNotReached`.
   - `redeem` before resolution → `MarketNotResolved`.
   - **`redeem` twice** → must not double-pay (see T08's report for the mechanism).
   - Trade with a token account of the **wrong mint** → `InvalidMint`.
   - Pass a **fake vault** account → `InvalidVault`.
6. **Multi-user interleaving** (`tests/concurrency.ts`) — several users trading
   both outcomes in interleaved order; assert the vault never goes insolvent and
   final redemption obligations are always covered. This is the on-chain
   counterpart to T04's bounded-loss property.
7. `tests/README.md` — how to run, what each file covers, known-flaky notes.

## Definition of done

- `anchor build --arch v0` then `anchor test --skip-build --validator legacy`
  passes end to end from a clean state (`deploy/` wiped, so no stale artifact
  can mask a failure).
- Full lifecycle covered in order.
- Every negative test asserts a specific error code.
- Parity against `reference/vectors/trades.json` is exact.
- Vault solvency asserted throughout; final residual dust quantified.

## Report back

Pass/fail counts, the final vault residual after full redemption and whether it
matches the documented rounding policy, any parity mismatch with exact numbers,
and **every program bug found** as a precise finding rather than a fix.
