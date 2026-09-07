# T05 — Anchor workspace + state accounts

**Depends on:** T00 · **Blocks:** T06, T08
**Owns:** `Anchor.toml`, `Cargo.toml` (workspace root), `programs/greekbet/Cargo.toml`,
`programs/greekbet/src/{lib.rs, state.rs, errors.rs, constants.rs}`,
`programs/greekbet/src/instructions/mod.rs`, `.gitignore`

## Context

Plan §2.1. Structure only — **no instruction logic** (T06/T07/T08 own that).
Your job is to lay down a workspace the other tickets can build into without
colliding.

## Tasks

1. `anchor init` the workspace in place (program name `greekbet`), then wire the
   existing `crates/lmsr` in as a **workspace member** and a path dependency of
   the program. Both must build under one root `Cargo.toml`.
   - `crates/lmsr` may not exist or may be mid-flight when you start — depend on
     it by path regardless and note it if it does not compile yet.
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
7. `.gitignore` — `target/`, `.anchor/`, `node_modules/`, `test-ledger/`,
   `*.so`, keypairs.
8. `anchor build` must succeed.

## Definition of done

- `anchor build` succeeds in WSL.
- `cargo test -p lmsr` still passes (workspace integration did not break it).
- Account size test passes.
- Six instruction stubs exist with correct signatures and clear ticket ownership.

## Report back

The program ID generated, the exact stub signatures (T06/T07/T08 code against
them), computed account sizes, and the Anchor version used.
