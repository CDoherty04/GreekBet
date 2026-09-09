//! `create_market` — **owned by T06.**
//!
//! Creator deposits seed collateral and initialises LMSR state (plan §2.2).
//!
//! # The one thing to understand about this instruction
//!
//! The vault is seeded with **`lmsr::cost(0, 0, b)` = `b·ln 2`**, computed on
//! chain, never hardcoded. That number is not arbitrary: it is exactly the LMSR
//! market maker's worst-case subsidy (plan §1.4), and depositing it up front is
//! the whole reason the vault can always pay every winner.
//!
//! Sketch of why. Traders pay `C(q') − C(q)` on every buy and are refunded the
//! same difference on every sell, so after any sequence of trades the vault
//! holds `seed + C(q) − C(0,0)`. At resolution the program owes the winners
//! exactly `q_win`, because shares redeem 1:1 (D1/D2, and T08's
//! `SHARES_TO_COLLATERAL_SCALE`). Solvency therefore needs
//!
//! ```text
//! seed + C(q) − C(0,0) ≥ q_win     for every reachable q
//! ```
//!
//! and since `C(q) = m + b·ln(e^((q_yes−m)/b) + e^((q_no−m)/b)) ≥ m =
//! max(q_yes, q_no) ≥ q_win`, choosing `seed = C(0,0) = b·ln 2` makes the
//! inequality hold in every state. No trade sequence can drain the vault.
//!
//! `lmsr::max_loss_bound(b)` is the same quantity rounded **up**;
//! `lmsr::cost(0, 0, b)` rounds **down** and is what the ticket specifies, so
//! that is what is used here. The two differ by at most one base unit (1e-6
//! USDC), and the inequality above has `C(q) − q_win ≥ 0` slack on top, so the
//! rounding direction is not load-bearing.
//!
//! # `resolver`
//!
//! Stored verbatim and otherwise unused (plan §2.2/§2.3). There is deliberately
//! no validation of it beyond it being a `Pubkey`, and no resolver logic — it is
//! a seam for a future oracle/dispute system, not a feature of this phase.
//!
//! # PDA derivation (load-bearing for T07 and T08)
//!
//! * market: `[MARKET_SEED, creator, sha256(question)]`
//! * vault:  `[VAULT_SEED, market]`, an SPL token account whose **authority is
//!   the market PDA** (plan §2.1)
//!
//! Because the vault's authority is the market, every later vault withdrawal
//! signs with the *market's* seeds and `market.bump` — not with `vault_bump`,
//! which is only the vault PDA's own derivation bump and signs for nothing.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::constants::{COLLATERAL_DECIMALS, MARKET_SEED, VAULT_SEED};
use crate::errors::{GreekBetError, LmsrResultExt};
use crate::state::{validate_question_len, Market, MarketStatus};

/// Accounts for [`create_market_handler`].
///
/// Every check that *can* be an account constraint is one: constraints land in
/// the IDL, run before the handler body, and cannot be forgotten in a later
/// edit of the handler. Only checks that depend on instruction arguments rather
/// than account contents live in the handler.
#[derive(Accounts)]
#[instruction(question: String)]
pub struct CreateMarket<'info> {
    /// Pays rent for both new accounts and funds the vault seed.
    #[account(mut)]
    pub creator: Signer<'info>,

    /// The new market. Seeds are `[MARKET_SEED, creator, sha256(question)]`, so
    /// one creator can run many markets and two creators asking the same
    /// question cannot collide.
    ///
    /// # Why the hash seed is written `&question_hash(&question)`
    ///
    /// Not stylistic — the alternative does not build. Anchor 1.2.0's IDL
    /// generator (`anchor_syn::idl::accounts::parse_seed`) can only describe
    /// seeds that are constants, whole instruction arguments, or account
    /// fields. A `MethodCall` seed such as `question_hash(&question).as_ref()`
    /// falls into its catch-all branch, which re-emits the expression verbatim
    /// into a generated function where the instruction arguments are **not** in
    /// scope: `anchor build` then fails the IDL step with
    /// `E0425: cannot find value 'question' in this scope`, even though the
    /// `.so` itself compiles.
    ///
    /// Written as a reference to a call with arguments, `parse_seed` instead
    /// returns `Err`, `get_pda` swallows it, and the account is emitted with no
    /// `pda` metadata — which is the correct outcome anyway, since "SHA-256 of
    /// an argument" is not expressible in the IDL's seed vocabulary. The
    /// on-chain derivation is unaffected: that constraint is expanded inside
    /// `try_accounts`, where `question` is in scope.
    ///
    /// Consequence for clients (T09/T10): `anchor.web3` cannot auto-derive this
    /// PDA. Derive it explicitly as
    /// `findProgramAddressSync([Buffer.from("market"), creator.toBuffer(), sha256(question)], programId)`.
    #[account(
        init,
        payer = creator,
        space = Market::LEN,
        seeds = [MARKET_SEED, creator.key().as_ref(), &question_hash(&question)],
        bump,
    )]
    pub market: Account<'info, Market>,

    /// The market's collateral mint — **per-market runtime config** (D3), never
    /// a program constant.
    ///
    /// The decimals check is what lets T08 redeem winning shares 1:1: share
    /// counts and collateral must be the same 6-decimal base unit, and a mint
    /// with different decimals would silently break that mapping.
    #[account(
        constraint = collateral_mint.decimals == COLLATERAL_DECIMALS
            @ GreekBetError::InvalidMintDecimals,
    )]
    pub collateral_mint: Account<'info, Mint>,

    /// The market's collateral vault: an SPL token account for
    /// `collateral_mint` whose **authority is the market PDA** (plan §2.1), so
    /// only this program can move collateral out of it.
    ///
    /// Declared after `market` and `collateral_mint` because its seeds and its
    /// `token::*` constraints reference both — Anchor resolves accounts in
    /// declaration order.
    #[account(
        init,
        payer = creator,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = market,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Where the `b·ln 2` seed deposit comes from. Must hold the market's
    /// collateral mint and belong to the creator.
    #[account(
        mut,
        constraint = creator_token_account.mint == collateral_mint.key()
            @ GreekBetError::InvalidMint,
        constraint = creator_token_account.owner == creator.key()
            @ GreekBetError::Unauthorized,
    )]
    pub creator_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Emitted once per successful `create_market`.
#[event]
pub struct MarketCreated {
    /// The new market PDA.
    pub market: Pubkey,
    /// Who created it and paid the seed.
    pub creator: Pubkey,
    /// Stored verbatim; unused in this phase.
    pub resolver: Pubkey,
    /// The market's collateral mint (D3).
    pub collateral_mint: Pubkey,
    /// The market's collateral vault token account.
    pub vault: Pubkey,
    /// SHA-256 of the question bytes — the third market PDA seed.
    pub question_hash: [u8; 32],
    /// LMSR liquidity parameter, base units.
    pub b: u64,
    /// `lmsr::cost(0, 0, b)`, the amount actually moved into the vault.
    pub seed_amount: u64,
    /// `Clock::unix_timestamp` at creation.
    pub created_at: i64,
    /// When trading stops and `close_market` may be cranked.
    pub close_time: i64,
}

/// Create a market and seed its vault with the LMSR max subsidy.
pub fn create_market_handler(
    ctx: Context<CreateMarket>,
    question: String,
    close_time: i64,
    initial_liquidity_b: u64,
    resolver: Pubkey,
) -> Result<()> {
    // ---- argument validation, before any tokens move -------------------
    //
    // The cap counts UTF-8 *bytes*, not characters — it is what keeps `Market`
    // fixed-size at `Market::LEN`.
    validate_question_len(&question)?;

    // D4: 10 USDC <= b <= 1,000,000 USDC. `lmsr::cost` re-checks this, but
    // calling `validate_b` explicitly guarantees the failure is `BOutOfRange`
    // rather than whatever the cost path surfaces first.
    lmsr::validate_b(initial_liquidity_b).or_program_err()?;

    let clock = Clock::get()?;
    require!(
        close_time > clock.unix_timestamp,
        GreekBetError::CloseTimeInPast
    );

    // ---- seed the vault ------------------------------------------------
    //
    // `lmsr::cost(0, 0, b)` == `b·ln 2` == the market maker's maximum possible
    // subsidy. See this module's header for why depositing exactly this makes
    // the market solvent in every reachable state. Computed, never a magic
    // number: it is a function of `b`, which is a runtime argument.
    let seed_amount = lmsr::cost(0, 0, initial_liquidity_b).or_program_err()?;

    // `transfer_checked` rather than `transfer`: it makes the token program
    // re-verify the mint and its decimals in the CPI, a free second opinion on
    // the `InvalidMintDecimals` constraint above.
    //
    // Anchor 1.2.0's `CpiContext::new` takes the program **`Pubkey`**, not an
    // `AccountInfo` — `.to_account_info()` here is a type error, unlike in
    // Anchor 0.2x.
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.creator_token_account.to_account_info(),
                mint: ctx.accounts.collateral_mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.creator.to_account_info(),
            },
        ),
        seed_amount,
        ctx.accounts.collateral_mint.decimals,
    )?;

    // ---- initialise state ----------------------------------------------
    let hash = question_hash(&question);
    let creator = ctx.accounts.creator.key();
    let collateral_mint = ctx.accounts.collateral_mint.key();
    let vault = ctx.accounts.vault.key();
    let market_key = ctx.accounts.market.key();

    let market = &mut ctx.accounts.market;
    market.creator = creator;
    // Stored verbatim. No validation, no logic — plan §2.2/§2.3.
    market.resolver = resolver;
    market.collateral_mint = collateral_mint;
    market.vault = vault;
    market.question_hash = hash;
    market.question = question;
    market.created_at = clock.unix_timestamp;
    market.close_time = close_time;
    market.b = initial_liquidity_b;
    market.q_yes = 0;
    market.q_no = 0;
    market.status = MarketStatus::Open;
    market.winning_outcome = None;
    // `bump` is the bump of `[MARKET_SEED, creator, question_hash]` and is the
    // signing bump for every later vault withdrawal (T07/T08). `vault_bump` is
    // the vault PDA's own derivation bump and signs for nothing.
    market.bump = ctx.bumps.market;
    market.vault_bump = ctx.bumps.vault;

    emit!(MarketCreated {
        market: market_key,
        creator,
        resolver,
        collateral_mint,
        vault,
        question_hash: hash,
        b: initial_liquidity_b,
        seed_amount,
        created_at: clock.unix_timestamp,
        close_time,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

/// SHA-256 of the question bytes — the third seed of the market PDA.
///
/// Re-exported from [`crate::state::hash_question`], which is where the
/// implementation lives so the seed derivation sits next to the
/// [`Market::question_hash`] field it fills.
///
/// T06 originally hand-rolled FIPS 180-4 here because `anchor-lang` 1.2.0
/// re-exports no hasher and neither does `anchor-spl`. That is now replaced by
/// the `solana-sha256-hasher` crate, which lowers to the `sol_sha256` syscall
/// on-chain instead of running compression rounds in BPF. The digest is
/// unchanged — the NIST vectors below still pin it — so the market PDA
/// derivation is byte-for-byte the same.
pub use crate::state::hash_question as question_hash;

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8; 32]) -> String {
        use std::fmt::Write as _;
        bytes.iter().fold(String::new(), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
    }

    /// FIPS 180-4 vectors, retained from T06's hand-rolled implementation and
    /// now pointed at `solana-sha256-hasher`.
    ///
    /// **These are the regression guard for that swap.** They pin the digest to
    /// what any client-side `sha256()` produces, which is what makes the market
    /// PDA derivable off-chain — Anchor's IDL cannot express a hashed seed, so
    /// clients must derive it themselves. If these still pass, the replacement
    /// changed nothing observable about PDA derivation.
    ///
    /// The four inputs cover every padding path: empty, one block, the 56-byte
    /// boundary where the length no longer fits the first padded block, and a
    /// 112-byte message needing a whole extra padding block.
    #[test]
    fn sha256_matches_known_vectors() {
        assert_eq!(
            hex(&question_hash("")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex(&question_hash("abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex(&question_hash(
                "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
            )),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        assert_eq!(
            hex(&question_hash(
                "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"
            )),
            "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"
        );
    }

    /// The market PDA seed must be the SHA-256 of the raw UTF-8 bytes and
    /// nothing else — no normalisation, no length prefix, no lowercasing.
    #[test]
    fn question_hash_is_sha256_of_the_raw_bytes() {
        // A realistic question, long enough to need two compression blocks.
        // Digest independently produced by Python `hashlib.sha256`.
        let q = "Will ETH close above $4,000 on 2026-12-31 according to Coinbase?";
        assert_eq!(
            hex(&question_hash(q)),
            "b1951eb560577570687059e1aa07ff8f8b56640c18cc0de14845dd3b7a29c79b"
        );

        // The cap is a BYTE cap: a 200-char multibyte string is 400 bytes. It
        // hashes fine — it is `validate_question_len` that rejects it, and the
        // two must not disagree about which strings are representable.
        let long = "é".repeat(200);
        assert_eq!(long.len(), 400);
        assert!(validate_question_len(&long).is_err());

        // Distinct questions must not collide into the same market PDA.
        assert_ne!(question_hash("a"), question_hash("b"));
        assert_ne!(question_hash("abc"), question_hash("ABC"));
    }

    /// The seed deposit is a computed function of `b`, never a constant, and
    /// always strictly positive across the whole legal `b` range (D4).
    #[test]
    fn seed_amount_is_b_ln2_over_the_whole_legal_range() {
        for b in [lmsr::B_MIN, 100_000_000, 1_000_000_000, lmsr::B_MAX] {
            let seed = lmsr::cost(0, 0, b).expect("b is in range");
            let ceil = lmsr::max_loss_bound(b).expect("b is in range");
            assert!(seed > 0, "b={b} seeded nothing");
            // floor vs ceil of the same quantity: at most one base unit apart.
            assert!(ceil - seed <= 1, "b={b}: cost={seed} max_loss={ceil}");
            // b * ln2 ~= 0.693147 * b, within a base unit of rounding.
            let expected = ((b as u128) * 693_147_180_559_945_309u128) / 1_000_000_000_000_000_000;
            assert!(
                (seed as u128).abs_diff(expected) <= 1,
                "b={b}: seed={seed} expected~{expected}"
            );
        }
    }
}
