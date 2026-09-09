//! Instruction handlers, one module per instruction (plan §2.2).
//!
//! **File ownership is strict**, because these tickets run in parallel:
//!
//! | module | ticket |
//! |---|---|
//! | `create_market`, `close_market`, `resolve_market` | T06 |
//! | `buy_shares`, `sell_shares` | T07 |
//! | `redeem` | T08 |
//!
//! T05 owns only this file and the placeholder bodies. Each module currently
//! holds a minimal `#[derive(Accounts)]` context and a `todo!()` handler so the
//! crate compiles; the owning ticket replaces both. A `todo!()` is deliberate —
//! it makes it impossible to ship a stub that silently succeeds.
//!
//! Do not edit a module you do not own. If you need a field on a shared type,
//! report it: `state.rs`, `errors.rs`, and `constants.rs` belong to T05.

pub mod buy_shares;
pub mod close_market;
pub mod create_market;
pub mod redeem;
pub mod resolve_market;
pub mod sell_shares;

// These globs are REQUIRED, not stylistic. Anchor's `#[program]` macro expands
// to code referencing the `__client_accounts_*` and `__cpi_client_accounts_*`
// modules that `#[derive(Accounts)]` generates inside each instruction module;
// without the glob, `lib.rs` fails to compile with a bare
// `unresolved import `crate`` pointing at `#[program]`.
//
// Because of that, handlers must NOT all be named `handler` — globbing six
// modules that each export `handler` makes the name ambiguous. Each is named
// `<instruction>_handler` instead. Keep that convention when filling in a body.
pub use buy_shares::*;
pub use close_market::*;
pub use create_market::*;
pub use redeem::*;
pub use resolve_market::*;
pub use sell_shares::*;
