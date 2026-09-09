/**
 * The six market actions. **Server-only.**
 *
 * Each builds, signs and submits a transaction against the LMSR program and
 * returns the signature plus whatever the caller needs to update the UI.
 *
 * Amounts crossing this boundary are **base units as strings** (`bigint` where
 * arithmetic is needed). Shares reach 1e15 and a JSON number would silently
 * lose precision at the top of the range.
 */

import "server-only";

import { BN } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";

import { COLLATERAL_MINT, DEFAULT_B } from "./config";
import { deriveMarket, derivePosition, deriveVault, questionHash } from "./pdas";
import { connection, programFor, sendAndConfirm } from "./program";
import { quoteBuy, quoteSell } from "./quote";

export type Outcome = "yes" | "no";

/** Anchor encodes a unit enum variant as `{ yes: {} }`. */
const outcomeArg = (o: Outcome) => (o === "yes" ? { yes: {} } : { no: {} });

/**
 * Trades touch two LMSR calls plus a token CPI. Measured on devnet:
 * `sell_shares` is the dearest at ~56,500 CU — comfortably under the 200,000
 * default, so the limit is raised only to leave headroom, never because the
 * default is insufficient.
 */
const computeBudget = () =>
  ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 });

/** The user's collateral ATA, creating it if this is their first interaction. */
async function ensureAta(
  owner: PublicKey,
  payer: Keypair,
  mint: PublicKey,
): Promise<{ address: PublicKey; ix: TransactionInstruction | null }> {
  const address = await getAssociatedTokenAddress(mint, owner, true);
  try {
    await getAccount(connection(), address);
    return { address, ix: null };
  } catch {
    return {
      address,
      ix: createAssociatedTokenAccountInstruction(
        payer.publicKey,
        address,
        owner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    };
  }
}

export interface CreateMarketResult {
  market: string;
  vault: string;
  signature: string;
  seedAmount: string;
}

/**
 * Create a market and seed its vault.
 *
 * The creator deposits `C(0,0) = b·ln2` — the LMSR's maximum possible subsidy.
 * That is real money they can lose: it is what pays winners when the market
 * moves against the house. At the default `b` of 10 USDC that is ~6.93 USDC.
 */
export async function createMarket(input: {
  creator: Keypair;
  resolver: PublicKey;
  question: string;
  closeTime: number;
  b?: number;
  mint?: PublicKey;
}): Promise<CreateMarketResult> {
  const mint = input.mint ?? COLLATERAL_MINT;
  const b = input.b ?? DEFAULT_B;
  const [market] = deriveMarket(input.creator.publicKey, input.question);
  const [vault] = deriveVault(market);

  const program = programFor(input.creator);
  const { address: creatorAta, ix: ataIx } = await ensureAta(
    input.creator.publicKey,
    input.creator,
    mint,
  );

  const ix = await program.methods
    .createMarket(
      input.question,
      new BN(input.closeTime),
      new BN(b),
      input.resolver,
    )
    .accounts({
      creator: input.creator.publicKey,
      market,
      collateralMint: mint,
      vault,
      creatorTokenAccount: creatorAta,
    })
    .instruction();

  const signature = await sendAndConfirm(
    [computeBudget(), ...(ataIx ? [ataIx] : []), ix],
    [input.creator],
    input.creator.publicKey,
  );

  // b·ln2, floored — the same value the program computed via lmsr::cost(0,0,b).
  const seedAmount = (
    (BigInt(b) * 693_147_180_559_945_309n) /
    1_000_000_000_000_000_000n
  ).toString();

  return {
    market: market.toBase58(),
    vault: vault.toBase58(),
    signature,
    seedAmount,
  };
}

export interface TradeResult {
  signature: string;
  /** Shares received (buy) or collateral received (sell), base units. */
  received: string;
  quotedReceived: string;
}

/**
 * Buy `outcome` shares with `collateral` base units.
 *
 * Slippage is a **floor on shares received**, not a price tolerance: a
 * price-based limit would have to say which price (marginal-before,
 * marginal-after, average-paid) and those differ by exactly the impact being
 * guarded against. The floor comes from a simulation of the real instruction,
 * so it reflects the program's own fixed-point math rather than a reimplementation.
 */
export async function buyShares(input: {
  trader: Keypair;
  market: PublicKey;
  outcome: Outcome;
  collateral: bigint;
  /** Fraction, e.g. 0.01 for 1%. Applied to the simulated quote. */
  slippage?: number;
  mint?: PublicKey;
}): Promise<TradeResult> {
  const mint = input.mint ?? COLLATERAL_MINT;
  const [vault] = deriveVault(input.market);
  const [position] = derivePosition(input.market, input.trader.publicKey);
  const program = programFor(input.trader);
  const { address: traderAta, ix: ataIx } = await ensureAta(
    input.trader.publicKey,
    input.trader,
    mint,
  );

  const quoted = await quoteBuy({
    trader: input.trader,
    market: input.market,
    outcome: input.outcome,
    collateral: input.collateral,
    traderAta,
    vault,
    position,
  });

  const tolerance = input.slippage ?? 0.01;
  const minSharesOut =
    (quoted * BigInt(Math.round((1 - tolerance) * 10_000))) / 10_000n;

  const ix = await program.methods
    .buyShares(
      outcomeArg(input.outcome),
      new BN(input.collateral.toString()),
      new BN(minSharesOut.toString()),
    )
    .accounts({
      buyer: input.trader.publicKey,
      market: input.market,
      position,
      vault,
      buyerTokenAccount: traderAta,
    })
    .instruction();

  const signature = await sendAndConfirm(
    [computeBudget(), ...(ataIx ? [ataIx] : []), ix],
    [input.trader],
    input.trader.publicKey,
  );

  return {
    signature,
    received: quoted.toString(),
    quotedReceived: quoted.toString(),
  };
}

/** Sell `shares` of `outcome` back to the market. */
export async function sellShares(input: {
  trader: Keypair;
  market: PublicKey;
  outcome: Outcome;
  shares: bigint;
  slippage?: number;
  mint?: PublicKey;
}): Promise<TradeResult> {
  const mint = input.mint ?? COLLATERAL_MINT;
  const [vault] = deriveVault(input.market);
  const [position] = derivePosition(input.market, input.trader.publicKey);
  const program = programFor(input.trader);
  const { address: traderAta, ix: ataIx } = await ensureAta(
    input.trader.publicKey,
    input.trader,
    mint,
  );

  const quoted = await quoteSell({
    trader: input.trader,
    market: input.market,
    outcome: input.outcome,
    shares: input.shares,
    traderAta,
    vault,
    position,
  });

  const tolerance = input.slippage ?? 0.01;
  const minUsdcOut =
    (quoted * BigInt(Math.round((1 - tolerance) * 10_000))) / 10_000n;

  const ix = await program.methods
    .sellShares(
      outcomeArg(input.outcome),
      new BN(input.shares.toString()),
      new BN(minUsdcOut.toString()),
    )
    .accounts({
      seller: input.trader.publicKey,
      market: input.market,
      position,
      vault,
      sellerTokenAccount: traderAta,
    })
    .instruction();

  const signature = await sendAndConfirm(
    [computeBudget(), ...(ataIx ? [ataIx] : []), ix],
    [input.trader],
    input.trader.publicKey,
  );

  return {
    signature,
    received: quoted.toString(),
    quotedReceived: quoted.toString(),
  };
}

/**
 * Crank a market closed. Permissionless by design — the transition carries no
 * discretion, and gating it on a key would let a lost key strand every position,
 * since resolution requires `Closed`.
 */
export async function closeMarket(input: {
  payer: Keypair;
  market: PublicKey;
}): Promise<string> {
  const program = programFor(input.payer);
  const ix = await program.methods
    .closeMarket()
    .accounts({ market: input.market })
    .instruction();
  return sendAndConfirm([ix], [input.payer], input.payer.publicKey);
}

/** Write the winning outcome. Only the stored resolver may do this. */
export async function resolveMarket(input: {
  resolver: Keypair;
  payer?: Keypair;
  market: PublicKey;
  outcome: Outcome;
}): Promise<string> {
  const program = programFor(input.resolver);
  const ix = await program.methods
    .resolveMarket(outcomeArg(input.outcome))
    .accounts({ market: input.market, resolver: input.resolver.publicKey })
    .instruction();

  const payer = input.payer ?? input.resolver;
  const signers =
    payer.publicKey.equals(input.resolver.publicKey)
      ? [input.resolver]
      : [payer, input.resolver];
  return sendAndConfirm([ix], signers, payer.publicKey);
}

/**
 * Redeem a resolved position: winning shares 1:1, losing shares zero.
 *
 * Succeeds for a pure loser too — they are paid nothing, their position is
 * cleared, and the account's rent is returned. Erroring on them would strand
 * the account forever.
 */
export async function redeem(input: {
  owner: Keypair;
  market: PublicKey;
  mint?: PublicKey;
}): Promise<string> {
  const mint = input.mint ?? COLLATERAL_MINT;
  const [vault] = deriveVault(input.market);
  const [position] = derivePosition(input.market, input.owner.publicKey);
  const program = programFor(input.owner);
  const { address: ownerAta, ix: ataIx } = await ensureAta(
    input.owner.publicKey,
    input.owner,
    mint,
  );

  const ix = await program.methods
    .redeem()
    .accounts({
      owner: input.owner.publicKey,
      market: input.market,
      position,
      vault,
      ownerTokenAccount: ownerAta,
    })
    .instruction();

  return sendAndConfirm(
    [computeBudget(), ...(ataIx ? [ataIx] : []), ix],
    [input.owner],
    input.owner.publicKey,
  );
}

export { questionHash };
