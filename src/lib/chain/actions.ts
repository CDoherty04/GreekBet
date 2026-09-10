/**
 * The six market actions. **Server-only.**
 *
 * User-facing actions (create / buy / sell / redeem) **build** unsigned
 * transactions for the client to sign with Privy. Resolver / close still
 * sign with server-held keypairs.
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
import {
  buildUnsignedTransaction,
  connection,
  programFor,
  readOnlyProgram,
  sendAndConfirm,
} from "./program";
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
  payer: PublicKey,
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
        payer,
        address,
        owner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    };
  }
}

export interface CreateMarketTx {
  transaction: string;
  market: string;
  vault: string;
  seedAmount: string;
}

/**
 * Build (unsigned) create-market + seed vault tx for the creator to sign.
 *
 * The creator deposits `C(0,0) = b·ln2` — the LMSR's maximum possible subsidy.
 */
export async function buildCreateMarketTx(input: {
  creator: PublicKey;
  resolver: PublicKey;
  question: string;
  closeTime: number;
  b?: number;
  mint?: PublicKey;
}): Promise<CreateMarketTx> {
  const mint = input.mint ?? COLLATERAL_MINT;
  const b = input.b ?? DEFAULT_B;
  const [market] = deriveMarket(input.creator, input.question);
  const [vault] = deriveVault(market);

  const program = readOnlyProgram();
  const { address: creatorAta, ix: ataIx } = await ensureAta(
    input.creator,
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
      creator: input.creator,
      market,
      collateralMint: mint,
      vault,
      creatorTokenAccount: creatorAta,
    })
    .instruction();

  const transaction = await buildUnsignedTransaction(
    [computeBudget(), ...(ataIx ? [ataIx] : []), ix],
    input.creator,
  );

  const seedAmount = (
    (BigInt(b) * 693_147_180_559_945_309n) /
    1_000_000_000_000_000_000n
  ).toString();

  return {
    transaction,
    market: market.toBase58(),
    vault: vault.toBase58(),
    seedAmount,
  };
}

export interface TradeTx {
  transaction: string;
  received: string;
}

/** Build an unsigned buy. */
export async function buildBuySharesTx(input: {
  trader: PublicKey;
  market: PublicKey;
  outcome: Outcome;
  collateral: bigint;
  slippage?: number;
  mint?: PublicKey;
}): Promise<TradeTx> {
  const mint = input.mint ?? COLLATERAL_MINT;
  const [vault] = deriveVault(input.market);
  const [position] = derivePosition(input.market, input.trader);
  const program = readOnlyProgram();
  const { address: traderAta, ix: ataIx } = await ensureAta(
    input.trader,
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
      buyer: input.trader,
      market: input.market,
      position,
      vault,
      buyerTokenAccount: traderAta,
    })
    .instruction();

  const transaction = await buildUnsignedTransaction(
    [computeBudget(), ...(ataIx ? [ataIx] : []), ix],
    input.trader,
  );

  return { transaction, received: quoted.toString() };
}

/** Build an unsigned sell. */
export async function buildSellSharesTx(input: {
  trader: PublicKey;
  market: PublicKey;
  outcome: Outcome;
  shares: bigint;
  slippage?: number;
  mint?: PublicKey;
}): Promise<TradeTx> {
  const mint = input.mint ?? COLLATERAL_MINT;
  const [vault] = deriveVault(input.market);
  const [position] = derivePosition(input.market, input.trader);
  const program = readOnlyProgram();
  const { address: traderAta, ix: ataIx } = await ensureAta(
    input.trader,
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
      seller: input.trader,
      market: input.market,
      position,
      vault,
      sellerTokenAccount: traderAta,
    })
    .instruction();

  const transaction = await buildUnsignedTransaction(
    [computeBudget(), ...(ataIx ? [ataIx] : []), ix],
    input.trader,
  );

  return { transaction, received: quoted.toString() };
}

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

/** Build an unsigned redeem. */
export async function buildRedeemTx(input: {
  owner: PublicKey;
  market: PublicKey;
  mint?: PublicKey;
}): Promise<{ transaction: string }> {
  const mint = input.mint ?? COLLATERAL_MINT;
  const [vault] = deriveVault(input.market);
  const [position] = derivePosition(input.market, input.owner);
  const program = readOnlyProgram();
  const { address: ownerAta, ix: ataIx } = await ensureAta(
    input.owner,
    input.owner,
    mint,
  );

  const ix = await program.methods
    .redeem()
    .accounts({
      owner: input.owner,
      market: input.market,
      position,
      vault,
      ownerTokenAccount: ownerAta,
    })
    .instruction();

  const transaction = await buildUnsignedTransaction(
    [computeBudget(), ...(ataIx ? [ataIx] : []), ix],
    input.owner,
  );
  return { transaction };
}

export { questionHash };

/** Script helpers: build + sign with a local Keypair (smoke tests). */
export async function createMarket(input: {
  creator: Keypair;
  resolver: PublicKey;
  question: string;
  closeTime: number;
  b?: number;
  mint?: PublicKey;
}): Promise<CreateMarketTx & { signature: string }> {
  const built = await buildCreateMarketTx({
    creator: input.creator.publicKey,
    resolver: input.resolver,
    question: input.question,
    closeTime: input.closeTime,
    b: input.b,
    mint: input.mint,
  });
  const signature = await signSerialized(built.transaction, input.creator);
  return { ...built, signature };
}

export async function buyShares(input: {
  trader: Keypair;
  market: PublicKey;
  outcome: Outcome;
  collateral: bigint;
  slippage?: number;
  mint?: PublicKey;
}): Promise<{ signature: string; received: string; quotedReceived: string }> {
  const built = await buildBuySharesTx({
    trader: input.trader.publicKey,
    market: input.market,
    outcome: input.outcome,
    collateral: input.collateral,
    slippage: input.slippage,
    mint: input.mint,
  });
  const signature = await signSerialized(built.transaction, input.trader);
  return {
    signature,
    received: built.received,
    quotedReceived: built.received,
  };
}

export async function sellShares(input: {
  trader: Keypair;
  market: PublicKey;
  outcome: Outcome;
  shares: bigint;
  slippage?: number;
  mint?: PublicKey;
}): Promise<{ signature: string; received: string; quotedReceived: string }> {
  const built = await buildSellSharesTx({
    trader: input.trader.publicKey,
    market: input.market,
    outcome: input.outcome,
    shares: input.shares,
    slippage: input.slippage,
    mint: input.mint,
  });
  const signature = await signSerialized(built.transaction, input.trader);
  return {
    signature,
    received: built.received,
    quotedReceived: built.received,
  };
}

async function signSerialized(
  transactionBase64: string,
  signer: Keypair,
): Promise<string> {
  const { Transaction } = await import("@solana/web3.js");
  const { connection: connFn, COMMITMENT } = await import("./program");
  const conn = connFn();
  const tx = Transaction.from(Buffer.from(transactionBase64, "base64"));
  tx.partialSign(signer);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw);
  const blockhash = tx.recentBlockhash!;
  const lastValidBlockHeight = tx.lastValidBlockHeight ?? 0;
  await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    COMMITMENT,
  );
  return sig;
}
