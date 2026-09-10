/**
 * Trade quoting by **simulation**. **Server-only.**
 *
 * Quotes come from simulating the real program instruction — not a JS LMSR.
 */

import "server-only";

import { BN, BorshCoder, EventParser } from "@anchor-lang/core";
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type SimulatedTransactionResponse,
  type TransactionInstruction,
} from "@solana/web3.js";

import { COMMITMENT, PROGRAM_ID, connection, idl, readOnlyProgram } from "./program";
import type { Outcome } from "./actions";

const outcomeArg = (o: Outcome) => (o === "yes" ? { yes: {} } : { no: {} });

function readEventField(
  sim: SimulatedTransactionResponse,
  eventName: string,
  field: string,
): bigint | null {
  const camel = field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const logs = sim.logs ?? [];
  const parser = new EventParser(PROGRAM_ID, new BorshCoder(idl));
  try {
    for (const ev of parser.parseLogs(logs) as Iterable<{
      name: string;
      data: Record<string, unknown>;
    }>) {
      const name = ev.name.charAt(0).toUpperCase() + ev.name.slice(1);
      if (name !== eventName) continue;
      const raw = ev.data[field] ?? ev.data[camel];
      if (raw === undefined || raw === null) continue;
      return BigInt((raw as { toString(): string }).toString());
    }
  } catch {
    return null;
  }
  return null;
}

function simulationError(sim: SimulatedTransactionResponse): string {
  const logs = sim.logs ?? [];
  const anchorMsg = logs.find((l) => l.includes("Error Message:"));
  if (anchorMsg) return anchorMsg.split("Error Message:")[1]?.trim() ?? anchorMsg;
  const codeLine = logs.find((l) => l.includes("Error Code:"));
  if (codeLine) return codeLine.trim();
  return "Simulation failed";
}

async function simulate(
  feePayer: PublicKey,
  instruction: TransactionInstruction,
): Promise<SimulatedTransactionResponse> {
  const conn = connection();
  const { blockhash } = await conn.getLatestBlockhash(COMMITMENT);
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions: [instruction],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const res = await conn.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: COMMITMENT,
  });
  return res.value;
}

export interface QuoteBuyInput {
  trader: PublicKey;
  market: PublicKey;
  outcome: Outcome;
  collateral: bigint;
  traderAta: PublicKey;
  vault: PublicKey;
  position: PublicKey;
}

export async function quoteBuy(input: QuoteBuyInput): Promise<bigint> {
  const program = readOnlyProgram();
  const ix = await program.methods
    .buyShares(
      outcomeArg(input.outcome),
      new BN(input.collateral.toString()),
      new BN(0),
    )
    .accounts({
      buyer: input.trader,
      market: input.market,
      position: input.position,
      vault: input.vault,
      buyerTokenAccount: input.traderAta,
    })
    .instruction();
  const sim = await simulate(input.trader, ix);
  if (sim.err) throw new Error(simulationError(sim));

  const shares = readEventField(sim, "SharesBought", "shares_out");
  if (shares === null) {
    throw new Error("Could not read a quote from the simulation");
  }
  return shares;
}

export interface QuoteSellInput {
  trader: PublicKey;
  market: PublicKey;
  outcome: Outcome;
  shares: bigint;
  traderAta: PublicKey;
  vault: PublicKey;
  position: PublicKey;
}

export async function quoteSell(input: QuoteSellInput): Promise<bigint> {
  const program = readOnlyProgram();
  const ix = await program.methods
    .sellShares(
      outcomeArg(input.outcome),
      new BN(input.shares.toString()),
      new BN(0),
    )
    .accounts({
      seller: input.trader,
      market: input.market,
      position: input.position,
      vault: input.vault,
      sellerTokenAccount: input.traderAta,
    })
    .instruction();

  const sim = await simulate(input.trader, ix);
  if (sim.err) throw new Error(simulationError(sim));

  const out = readEventField(sim, "SharesSold", "collateral_out");
  if (out === null) {
    throw new Error("Could not read a quote from the simulation");
  }
  return out;
}
