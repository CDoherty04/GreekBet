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

/// SHA-256 of the question bytes — the third seed of the market PDA and the
/// value stored in [`Market::question_hash`].
///
/// # Why this is implemented here instead of using the platform hasher
///
/// **This is a reported gap, not a preference.** `anchor-lang` 1.2.0 does not
/// re-export a hasher. Its `anchor_lang::solana_program` module covers
/// `account_info`, `clock`, `instruction`, `program`, `program_error`,
/// `program_memory`, `program_option`, `program_pack`, `pubkey`, `rent`,
/// `sysvar`, `log`, `system_program`, `system_instruction` and
/// `bpf_loader_upgradeable` — and no `hash` or `keccak`. `anchor-spl` 1.2.0 has
/// none either, and `const-crypto`'s `sha2` reaches this crate only as a
/// private transitive dependency of `anchor-lang`.
///
/// The proper fix is one line in `programs/greekbet/Cargo.toml`
/// (`solana-sha256-hasher`, already in `Cargo.lock` transitively) plus a
/// `hash_question()` helper in `state.rs` next to the field it fills. Both
/// files belong to T05, so this ticket cannot make that change; a pure-Rust
/// SHA-256 kept inside T06's own file is the only in-scope option.
///
/// It is the standard FIPS 180-4 construction, pinned by the test vectors
/// below, so the digest is byte-identical to any client-side `sha256(question)`
/// and the PDA derivation is unaffected. Swapping in the syscall later changes
/// nothing observable.
///
/// Cost is 4 compression rounds for a 200-byte question — negligible next to
/// the LMSR fixed-point work in the same instruction.
pub fn question_hash(question: &str) -> [u8; 32] {
    sha256(question.as_bytes())
}

/// FIPS 180-4 round constants.
///
/// `rustfmt::skip` keeps the table as a readable grid; the default one-per-line
/// formatting turns 64 constants into 64 lines for no benefit.
#[rustfmt::skip]
const SHA256_K: [u32; 64] = [
    0x428a_2f98, 0x7137_4491, 0xb5c0_fbcf, 0xe9b5_dba5, 0x3956_c25b, 0x59f1_11f1, 0x923f_82a4,
    0xab1c_5ed5, 0xd807_aa98, 0x1283_5b01, 0x2431_85be, 0x550c_7dc3, 0x72be_5d74, 0x80de_b1fe,
    0x9bdc_06a7, 0xc19b_f174, 0xe49b_69c1, 0xefbe_4786, 0x0fc1_9dc6, 0x240c_a1cc, 0x2de9_2c6f,
    0x4a74_84aa, 0x5cb0_a9dc, 0x76f9_88da, 0x983e_5152, 0xa831_c66d, 0xb003_27c8, 0xbf59_7fc7,
    0xc6e0_0bf3, 0xd5a7_9147, 0x06ca_6351, 0x1429_2967, 0x27b7_0a85, 0x2e1b_2138, 0x4d2c_6dfc,
    0x5338_0d13, 0x650a_7354, 0x766a_0abb, 0x81c2_c92e, 0x9272_2c85, 0xa2bf_e8a1, 0xa81a_664b,
    0xc24b_8b70, 0xc76c_51a3, 0xd192_e819, 0xd699_0624, 0xf40e_3585, 0x106a_a070, 0x19a4_c116,
    0x1e37_6c08, 0x2748_774c, 0x34b0_bcb5, 0x391c_0cb3, 0x4ed8_aa4a, 0x5b9c_ca4f, 0x682e_6ff3,
    0x748f_82ee, 0x78a5_636f, 0x84c8_7814, 0x8cc7_0208, 0x90be_fffa, 0xa450_6ceb, 0xbef9_a3f7,
    0xc671_78f2,
];

/// FIPS 180-4 initial hash value.
#[rustfmt::skip]
const SHA256_H0: [u32; 8] = [
    0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab,
    0x5be0_cd19,
];

/// One SHA-256 compression over a single 64-byte block.
///
/// Every addition here is `wrapping_add` **by specification** — SHA-256 is
/// defined over `Z/2^32`. This is the one place in the program where wrapping
/// arithmetic is the correct behaviour; the workspace `release` profile sets
/// `overflow-checks = true`, so a plain `+` would abort instead of hashing.
fn sha256_compress(state: &mut [u32; 8], block: &[u8; 64]) {
    let mut w = [0u32; 64];
    // `zip` stops after the 16 chunks the block actually has, filling w[0..16].
    for (word, chunk) in w.iter_mut().zip(block.as_chunks::<4>().0) {
        *word = u32::from_be_bytes(*chunk);
    }
    for i in 16..64 {
        let x = w[i - 15];
        let y = w[i - 2];
        let s0 = x.rotate_right(7) ^ x.rotate_right(18) ^ (x >> 3);
        let s1 = y.rotate_right(17) ^ y.rotate_right(19) ^ (y >> 10);
        w[i] = w[i - 16]
            .wrapping_add(s0)
            .wrapping_add(w[i - 7])
            .wrapping_add(s1);
    }

    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
    for (k, wi) in SHA256_K.iter().zip(w.iter()) {
        let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let ch = (e & f) ^ ((!e) & g);
        let t1 = h
            .wrapping_add(s1)
            .wrapping_add(ch)
            .wrapping_add(*k)
            .wrapping_add(*wi);
        let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let maj = (a & b) ^ (a & c) ^ (b & c);
        let t2 = s0.wrapping_add(maj);

        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(t1);
        d = c;
        c = b;
        b = a;
        a = t1.wrapping_add(t2);
    }

    for (s, v) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
        *s = s.wrapping_add(v);
    }
}

/// SHA-256 over an arbitrary byte slice.
fn sha256(data: &[u8]) -> [u8; 32] {
    let mut state = SHA256_H0;

    let (blocks, rem) = data.as_chunks::<64>();
    for block in blocks {
        sha256_compress(&mut state, block);
    }

    // Padding: 0x80, then zeros, then the 64-bit big-endian bit length. A
    // remainder of 56..=63 bytes leaves no room for the length and needs a
    // second block. `rem.len() <= 63`, so `block[rem.len()]` is always in
    // bounds.
    let mut block = [0u8; 64];
    block[..rem.len()].copy_from_slice(rem);
    block[rem.len()] = 0x80;
    if rem.len() >= 56 {
        sha256_compress(&mut state, &block);
        block = [0u8; 64];
    }
    // `data.len()` is bounded by the transaction size, so this cannot actually
    // wrap; `wrapping_mul` is used on the same principle as above rather than
    // relying on that bound.
    let bit_len = (data.len() as u64).wrapping_mul(8);
    block[56..].copy_from_slice(&bit_len.to_be_bytes());
    sha256_compress(&mut state, &block);

    let mut out = [0u8; 32];
    for (chunk, word) in out.as_chunks_mut::<4>().0.iter_mut().zip(state.iter()) {
        *chunk = word.to_be_bytes();
    }
    out
}

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

    /// FIPS 180-4 vectors. These pin the hand-rolled SHA-256 to the same digest
    /// any client-side `sha256()` produces, which is what makes the market PDA
    /// derivable off-chain. If this ever moves to the platform hasher, these
    /// must keep passing unchanged.
    #[test]
    fn sha256_matches_known_vectors() {
        // Empty input: a single all-padding block.
        assert_eq!(
            hex(&sha256(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        // 3 bytes: the canonical one-block vector.
        assert_eq!(
            hex(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // 56 bytes: exactly the boundary where the length no longer fits in the
        // first padded block, so this exercises the two-block padding path.
        assert_eq!(
            hex(&sha256(
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
            )),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        // 112 bytes: two full message blocks plus a whole extra padding block.
        assert_eq!(
            hex(&sha256(
                b"abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"
            )),
            "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"
        );
    }

    /// The market PDA seed must be the SHA-256 of the raw UTF-8 bytes and
    /// nothing else — no normalisation, no length prefix.
    #[test]
    fn question_hash_is_sha256_of_the_raw_bytes() {
        assert_eq!(question_hash("abc"), sha256(b"abc"));
        assert_eq!(question_hash(""), sha256(b""));
        // A realistic question, long enough to need two compression blocks.
        let q = "Will ETH close above $4,000 on 2026-12-31 according to Coinbase?";
        assert_eq!(question_hash(q), sha256(q.as_bytes()));
        // The cap is a byte cap: a 200-char multibyte string is 400 bytes and
        // hashes fine — it is `validate_question_len` that rejects it.
        let long = "é".repeat(200);
        assert_eq!(question_hash(&long), sha256(long.as_bytes()));
        assert!(validate_question_len(&long).is_err());
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
