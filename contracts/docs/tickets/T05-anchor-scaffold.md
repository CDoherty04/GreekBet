# T05 — Anchor workspace + state accounts

**Depends on:** T00 · **Blocks:** T06, T08
**Owns:** `Anchor.toml`, `Cargo.toml` (workspace root), `programs/greekbet/Cargo.toml`,
`programs/greekbet/src/{lib.rs, state.rs, errors.rs, constants.rs}`,
`programs/greekbet/src/instructions/mod.rs`, `.gitignore`

## Context

Plan §2.1. Structure only — **no instruction logic** (T06/T07/T08 own that).
Your job is to lay down a workspace the other tickets can build into without
colliding.

## Build environment — T00 is done, read `docs/TOOLCHAIN.md` first

Non-obvious things T00 established the hard way. Ignoring any of them costs you
an hour:

- **`anchor build --arch v0` is mandatory.** Anchor 1.2.0 defaults to sbpf v3;
  Agave 3.1.10 rejects it (`invalid file header` on deploy, `Unsupported program
  id` on the validator). `anchor test` accepts no `--arch` and
  `anchor test -- --arch v0` errors, so the sequence is **`anchor build --arch v0`
  then `anchor test --skip-build`**.
  **Trap T00 actually hit:** a stale v0 `.so` left in `deploy/` makes a broken v3
  build appear to pass. Wipe `deploy/` when in doubt.
- **`--validator legacy`** — Anchor 1.2 defaults to `surfpool`, which is not
  installed. Not your problem directly, but do not "fix" it by installing it;
  T09 wants `solana-test-validator`.
- **Environment lives in `~/.greekbet-env.sh`**, sourced from `~/.profile` and
  `~/.bashrc`. `bash -lc` picks it up; `~/.bashrc` alone does not (Ubuntu returns
  early for non-interactive shells). It exports
  `CARGO_TARGET_DIR=$HOME/.cache/greekbet-target`.
- **Anchor 1.2 does not override `CARGO_TARGET_DIR`.** Build output lands in the
  ext4 cache dir, so `./target` will not exist in the workspace. Consequence for
  you: generated TS tests import `../target/types/<program>`. `anchor build -i -t`
  is broken in 1.2.0, so the working fix is a symlink,
  `ln -sfn "$CARGO_TARGET_DIR" <workspace>/target`. Add `/target` to `.gitignore`.
- Cold `anchor build` took **10 minutes**; warm builds 4–22 s. Budget for it and
  do not abandon on a timeout.

## Tasks

1. `anchor init` the workspace in place (program name `greekbet`), then wire the
   existing `crates/lmsr` in as a **workspace member** and a path dependency of
   the program. Both must build under one root `Cargo.toml`.
   - **`crates/lmsr` exists and builds today, but there is no root workspace
     manifest yet** — so `cargo test -p lmsr` from the repo root currently fails
     with "could not find Cargo.toml"; it only works from inside `crates/lmsr/`.
     Creating that root manifest with `members = ["crates/*", "programs/*"]` is
     **your job** and is the fix. Verify `cargo test -p lmsr` passes from the
     root once you have added it.
   - The `Cargo.lock` belongs at the workspace root. Do not leave one inside
     `crates/lmsr/`.
   - `crates/lmsr` is `#![no_std]` with zero dependencies and
     `overflow-checks = true` under `[profile.release]`. Preserve that when
     folding it into the workspace — a root `[profile.release]` will override
     the crate's, so re-declare `overflow-checks = true` at the root. Losing it
     would turn a caught overflow into a silent wrap in deployed code.
2. `constants.rs` — PDA seed byte strings as named constants
   (`MARKET_SEED`, `VAULT_SEED`, `POSITION_SEED`). Never inline seed literals.
3. `state.rs` — accounts exactly per plan §2.1:
   - **`Market`**: `creator`, `resolver` (bare pubkey, stub — no logic),
     `collateral_mint`, `vault`, `question_hash: [u8; 32]` **plus** a bounded
     `question: String` (cap it, e.g. 200 bytes, and enforce the cap — an
     unbounded string is an account-size bug), `created_at: i64`,
     `close_time: i64`, `b: u64`, `q_yes: u64`, `q_no: u64`,
     `status: MarketStatus`, `winning_outcome: Option<Outcome>`, `bump`,
     `vault_bump`.
   - **`UserPosition`**: `market`, `owner`, `yes_shares: u64`, `no_shares: u64`,
     `bump`. Internal tracking, **no SPL outcome mints** — that is frozen in
     `docs/DESIGN_DECISIONS.md`.
   - `MarketStatus { Open, Closed, Resolved }`, `Outcome { Yes, No }`.
   - Explicit `LEN` consts (or `InitSpace`) with the 8-byte discriminant
     accounted for. Add a unit test asserting the computed size — a wrong `LEN`
     is a classic Anchor footgun.
   - **`collateral_mint` is stored per-market, never a hardcoded constant** —
     `docs/DESIGN_DECISIONS.md` D3 depends on this (custom mint locally, Circle
     USDC on devnet).
4. `errors.rs` — an `#[error_code]` enum covering everything T06–T08 will need:
   `MarketNotOpen`, `MarketNotClosed`, `MarketNotResolved`, `MarketAlreadyResolved`,
   `CloseTimeNotReached`, `CloseTimeInPast`, `Unauthorized`, `BOutOfRange`,
   `QOutOfRange`, `SlippageExceeded`, `InsufficientShares`, `InvalidMint`,
   `InvalidVault`, `QuestionTooLong`, `MathOverflow`, `NothingToRedeem`.
   Add a `From<lmsr::LmsrError>` conversion so LMSR failures surface as clean
   program errors instead of generic panics.
5. `lib.rs` — `declare_id!`, module wiring, and instruction handler stubs whose
   **signatures match plan §2.2 exactly** so T06/T07/T08 fill in bodies without
   touching each other's files. Each stub: `todo!()` or `Ok(())` with a comment
   naming its owning ticket.
6. `instructions/mod.rs` — declare all six modules, each with a placeholder file
   so the tree compiles.
7. `.gitignore` — `/target` (it is a symlink to the ext4 cache dir, see above),
   `.anchor/`, `node_modules/`, `test-ledger/`, `*.so`, keypairs. Note the repo
   root already has a `.gitattributes` pinning `*.sh` to LF — do not remove it,
   and do not let `anchor init` clobber it.
8. **`anchor build --arch v0` must succeed.** Plain `anchor build` produces an
   artifact Agave 3.1.10 cannot load.

## Definition of done

- `anchor build --arch v0` succeeds in WSL.
- `cargo test -p lmsr` still passes (workspace integration did not break it).
- Account size test passes.
- Six instruction stubs exist with correct signatures and clear ticket ownership.

## Report back

The program ID generated, the exact stub signatures (T06/T07/T08 code against
them), computed account sizes, and the Anchor version used.
