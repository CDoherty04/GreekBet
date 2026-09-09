//! On-chain account state (plan §2.1). Owned by T05 — T06/T07/T08 read and
//! mutate these types but must not change their shape. If you need a field that
//! is not here, report it rather than adding it yourself: every field changes
//! [`Market::LEN`] and therefore the rent-exemption every existing account was
//! sized for.
//!
//! Two decisions from `docs/DESIGN_DECISIONS.md` are baked into these structs
//! and are load-bearing:
//!
//! * **D2** — a position is *internal program state*. [`UserPosition`] holds
//!   plain `u64` share counts. There are no SPL outcome mints and shares are
//!   deliberately non-transferable.
//! * **D3** — the collateral mint is *per-market runtime config*, stored in
//!   [`Market::collateral_mint`]. It is never a program constant: local tests
//!   use a throwaway 6-decimal mint, devnet uses Circle's USDC. Every token
//!   account any instruction touches must be validated against this field.

use anchor_lang::prelude::*;

use crate::constants::MAX_QUESTION_LEN;
use crate::errors::GreekBetError;

/// Lifecycle of a market. Every instruction validates it (plan §2.3).
///
/// The only legal transitions are `Open → Closed → Resolved`. Nothing moves a
/// market backwards.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarketStatus {
    /// Trading is live. `create_market` (T06) leaves the market here.
    Open,
    /// `close_time` has passed and `close_market` (T06) has been cranked.
    /// No trading, no redemption yet.
    Closed,
    /// The resolver has written [`Market::winning_outcome`]. `redeem` (T08) is
    /// the only instruction that still does anything.
    Resolved,
}

/// Which side of the binary market a share or a trade refers to.
///
/// This is the program's own type, not `lmsr::Outcome`: the LMSR crate is
/// `no_std` and Anchor-free by design, so it cannot derive Anchor's
/// serialisation traits. The two are converted at the boundary with the
/// `From` impls below.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    /// The YES side, tracked by [`Market::q_yes`].
    Yes,
    /// The NO side, tracked by [`Market::q_no`].
    No,
}

impl Outcome {
    /// The opposite side.
    pub fn other(self) -> Self {
        match self {
            Outcome::Yes => Outcome::No,
            Outcome::No => Outcome::Yes,
        }
    }
}

impl From<Outcome> for lmsr::Outcome {
    fn from(o: Outcome) -> Self {
        match o {
            Outcome::Yes => lmsr::Outcome::Yes,
            Outcome::No => lmsr::Outcome::No,
        }
    }
}

impl From<lmsr::Outcome> for Outcome {
    fn from(o: lmsr::Outcome) -> Self {
        match o {
            lmsr::Outcome::Yes => Outcome::Yes,
            lmsr::Outcome::No => Outcome::No,
        }
    }
}

/// A single binary YES/NO market (plan §2.1). PDA, seeds
/// `[MARKET_SEED, creator, question_hash]`.
///
/// All quantities (`b`, `q_yes`, `q_no`) are 6-decimal base units — the same
/// unit the LMSR crate takes and returns, so they are passed straight through
/// with no scaling of any kind. See `docs/DESIGN_DECISIONS.md` D1.
#[account]
#[derive(InitSpace)]
pub struct Market {
    /// Who called `create_market` and seeded the vault.
    pub creator: Pubkey,
    /// The only key allowed to call `resolve_market`.
    ///
    /// **A bare pubkey and nothing more** (plan §2.2/§2.3). This is an
    /// intentional seam for a future oracle/dispute system; do not build
    /// resolver logic against it in this phase.
    pub resolver: Pubkey,
    /// The SPL mint this market takes collateral in — **per market, never a
    /// program constant** (D3). Every token account in every instruction is
    /// validated against this.
    pub collateral_mint: Pubkey,
    /// The market's collateral vault: an SPL token account for
    /// [`Self::collateral_mint`] whose authority is this market PDA.
    pub vault: Pubkey,
    /// SHA-256 of the question bytes. Part of the market PDA's seeds, so it is
    /// stored rather than recomputed, and lets a client verify the stored
    /// string was not tampered with.
    pub question_hash: [u8; 32],
    /// The human-readable question, capped at
    /// [`MAX_QUESTION_LEN`](crate::constants::MAX_QUESTION_LEN) bytes.
    ///
    /// The cap is what makes this account fixed-size; `create_market` must
    /// enforce it via [`validate_question_len`].
    #[max_len(MAX_QUESTION_LEN)]
    pub question: String,
    /// Unix timestamp of creation, from `Clock`.
    pub created_at: i64,
    /// Unix timestamp after which trading stops and `close_market` may be
    /// cranked.
    pub close_time: i64,
    /// LMSR liquidity parameter, in collateral base units. Constrained to
    /// `[lmsr::B_MIN, lmsr::B_MAX]` at creation (D4).
    pub b: u64,
    /// Outstanding YES shares, base units. Capped at `lmsr::MAX_Q` on every buy.
    pub q_yes: u64,
    /// Outstanding NO shares, base units. Capped at `lmsr::MAX_Q` on every buy.
    pub q_no: u64,
    /// Lifecycle state.
    pub status: MarketStatus,
    /// `None` until `resolve_market` runs; `Some(_)` exactly when
    /// [`Self::status`] is [`MarketStatus::Resolved`].
    ///
    /// T08 must not `unwrap` this — a `None` here with a `Resolved` status is
    /// an invariant violation and should surface as an error.
    pub winning_outcome: Option<Outcome>,
    /// Bump for the market PDA itself.
    pub bump: u8,
    /// Bump for the vault PDA. Stored so T07/T08 can sign vault withdrawals
    /// without re-deriving.
    pub vault_bump: u8,
}

impl Market {
    /// Total on-chain size in bytes, **including Anchor's 8-byte account
    /// discriminator**.
    ///
    /// ```text
    /// 8    discriminator
    /// 32   creator
    /// 32   resolver
    /// 32   collateral_mint
    /// 32   vault
    /// 32   question_hash
    /// 204  question           (4-byte Borsh length prefix + 200 bytes)
    /// 8    created_at
    /// 8    close_time
    /// 8    b
    /// 8    q_yes
    /// 8    q_no
    /// 1    status             (enum variant tag)
    /// 2    winning_outcome    (1 Option tag + 1 variant tag)
    /// 1    bump
    /// 1    vault_bump
    /// ---
    /// 417  total
    /// ```
    ///
    /// Use this (or `8 + Market::INIT_SPACE`, which the unit tests assert is
    /// the same number) as `space` in `init`. Getting it wrong is the classic
    /// Anchor footgun — an under-sized account fails at serialisation time, an
    /// over-sized one silently overcharges rent.
    pub const LEN: usize = 8 + Self::INIT_SPACE;

    /// `true` when the market is still accepting trades on the status flag
    /// alone. T07 must **also** check `close_time` — a market past its close
    /// time is untradeable even if nobody has cranked `close_market` yet.
    pub fn is_open(&self) -> bool {
        matches!(self.status, MarketStatus::Open)
    }

    /// The winning outcome, or an error. Deliberately provided so that no
    /// handler has to `unwrap` an `Option` on the redemption path (T08).
    pub fn require_resolved(&self) -> Result<Outcome> {
        require!(
            matches!(self.status, MarketStatus::Resolved),
            GreekBetError::MarketNotResolved
        );
        self.winning_outcome
            .ok_or_else(|| error!(GreekBetError::MarketNotResolved))
    }

    /// This market's share quantities in the order the LMSR crate takes them.
    pub fn q(&self) -> (u64, u64) {
        (self.q_yes, self.q_no)
    }
}

/// One user's holdings in one market (plan §2.1, D2). PDA, seeds
/// `[POSITION_SEED, market, owner]`.
///
/// **Internal accounting only.** There are no SPL outcome mints, so these
/// shares are not transferable and not composable with other programs. That is
/// a deliberate, frozen decision (D2); the migration path, if it is ever
/// wanted, is to mint SPL tokens against the same `q_yes`/`q_no` accounting
/// without touching the LMSR core.
///
/// Share counts are 6-decimal base units, the same unit as collateral — which
/// is what makes T08's winning-share redemption a straight 1:1 mapping.
#[account]
#[derive(InitSpace)]
pub struct UserPosition {
    /// The market this position belongs to.
    pub market: Pubkey,
    /// The owner. Only this key may sell or redeem.
    pub owner: Pubkey,
    /// YES shares held, base units.
    pub yes_shares: u64,
    /// NO shares held, base units.
    pub no_shares: u64,
    /// Bump for this PDA.
    pub bump: u8,
}

impl UserPosition {
    /// Total on-chain size in bytes, **including the 8-byte discriminator**.
    ///
    /// ```text
    /// 8   discriminator
    /// 32  market
    /// 32  owner
    /// 8   yes_shares
    /// 8   no_shares
    /// 1   bump
    /// --
    /// 89  total
    /// ```
    pub const LEN: usize = 8 + Self::INIT_SPACE;

    /// Shares held on one side.
    pub fn shares(&self, outcome: Outcome) -> u64 {
        match outcome {
            Outcome::Yes => self.yes_shares,
            Outcome::No => self.no_shares,
        }
    }

    /// `true` when the position holds nothing on either side. T08 uses this to
    /// distinguish "loser closing out" (allowed, pays zero) from "nothing to
    /// redeem" (an error).
    pub fn is_empty(&self) -> bool {
        self.yes_shares == 0 && self.no_shares == 0
    }
}

/// SHA-256 of the question's raw UTF-8 bytes — the third seed of the market
/// PDA and the value stored in [`Market::question_hash`].
///
/// Kept here, beside the field it fills, so the seed derivation and the stored
/// value cannot drift apart.
///
/// **The digest must be byte-identical to a client-side `sha256(question)`**,
/// because that is what makes the market PDA derivable off-chain — Anchor's IDL
/// cannot express a hashed seed, so clients derive it explicitly:
///
/// ```text
/// findProgramAddressSync(
///   [Buffer.from("market"), creator.toBuffer(), sha256(question)],
///   programId,
/// )
/// ```
///
/// Raw bytes only: no Unicode normalisation, no length prefix, no lowercasing.
/// On-chain this compiles to the `sol_sha256` syscall rather than running the
/// compression rounds in BPF.
pub fn hash_question(question: &str) -> [u8; 32] {
    solana_sha256_hasher::hash(question.as_bytes()).to_bytes()
}

/// Enforce the question-length cap.
///
/// Called by T06's `create_market` before the account is written. Kept here,
/// next to the `#[max_len]` attribute it mirrors, so the two cannot drift.
pub fn validate_question_len(question: &str) -> Result<()> {
    require!(
        question.len() <= MAX_QUESTION_LEN,
        GreekBetError::QuestionTooLong
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::Space;

    /// The whole point of this module's test coverage: a wrong `LEN` is the
    /// classic Anchor account-sizing footgun, and it does not show up until an
    /// account fails to serialise on-chain. Both the derived `INIT_SPACE` and
    /// the hand-computed byte total are asserted so that a field added without
    /// updating the doc comment breaks the build.
    #[test]
    fn market_len_matches_hand_computed_size() {
        // 4 pubkeys + hash + string + 5 * 8 + status + option + 2 bumps
        let expected_init_space = 32 * 4      // creator, resolver, collateral_mint, vault
            + 32                              // question_hash
            + (4 + MAX_QUESTION_LEN)          // question
            + 8 * 5                           // created_at, close_time, b, q_yes, q_no
            + MarketStatus::INIT_SPACE        // status
            + (1 + Outcome::INIT_SPACE)       // winning_outcome: Option<Outcome>
            + 1                               // bump
            + 1; // vault_bump
        assert_eq!(Market::INIT_SPACE, expected_init_space);
        assert_eq!(Market::INIT_SPACE, 409);
        assert_eq!(Market::LEN, 8 + Market::INIT_SPACE);
        assert_eq!(Market::LEN, 417);
    }

    #[test]
    fn user_position_len_matches_hand_computed_size() {
        let expected_init_space = 32 * 2 // market, owner
            + 8 * 2                      // yes_shares, no_shares
            + 1; // bump
        assert_eq!(UserPosition::INIT_SPACE, expected_init_space);
        assert_eq!(UserPosition::INIT_SPACE, 81);
        assert_eq!(UserPosition::LEN, 8 + UserPosition::INIT_SPACE);
        assert_eq!(UserPosition::LEN, 89);
    }

    /// Fieldless enums are one Borsh byte. If a future variant ever carries a
    /// payload, both `LEN` constants move and this catches it.
    #[test]
    fn enums_are_single_byte() {
        assert_eq!(MarketStatus::INIT_SPACE, 1);
        assert_eq!(Outcome::INIT_SPACE, 1);
    }

    #[test]
    fn question_cap_is_enforced() {
        assert!(validate_question_len(&"a".repeat(MAX_QUESTION_LEN)).is_ok());
        assert!(validate_question_len(&"a".repeat(MAX_QUESTION_LEN + 1)).is_err());
        assert!(validate_question_len("").is_ok());
    }

    /// The `question` cap is a *byte* cap, not a character cap — Borsh
    /// serialises UTF-8 bytes, so a 200-char string of multi-byte characters
    /// would not fit. Pinning the behaviour here so T06 does not assume
    /// otherwise.
    #[test]
    fn question_cap_counts_bytes_not_chars() {
        let s = "é".repeat(MAX_QUESTION_LEN); // 2 bytes each
        assert_eq!(s.chars().count(), MAX_QUESTION_LEN);
        assert!(validate_question_len(&s).is_err());
    }

    #[test]
    fn outcome_round_trips_through_lmsr() {
        for o in [Outcome::Yes, Outcome::No] {
            assert_eq!(Outcome::from(lmsr::Outcome::from(o)), o);
        }
        assert_eq!(lmsr::Outcome::from(Outcome::Yes), lmsr::Outcome::Yes);
        assert_eq!(lmsr::Outcome::from(Outcome::No), lmsr::Outcome::No);
        assert_eq!(Outcome::Yes.other(), Outcome::No);
        assert_eq!(Outcome::No.other(), Outcome::Yes);
    }

    #[test]
    fn user_position_helpers() {
        let p = UserPosition {
            market: Pubkey::default(),
            owner: Pubkey::default(),
            yes_shares: 5,
            no_shares: 0,
            bump: 254,
        };
        assert_eq!(p.shares(Outcome::Yes), 5);
        assert_eq!(p.shares(Outcome::No), 0);
        assert!(!p.is_empty());
        let empty = UserPosition {
            market: Pubkey::default(),
            owner: Pubkey::default(),
            yes_shares: 0,
            no_shares: 0,
            bump: 254,
        };
        assert!(empty.is_empty());
    }
}
