/**
 * Trade quoting by **simulation**. **Server-only.**
 *
 * ## Why not compute the LMSR in TypeScript
 *
 * To set a slippage floor the UI has to predict the trade. Reimplementing the
 * cost function here would be a trap: the program works in Q64.64 fixed point,
 * and its own test suite found that even a high-precision reference disagrees
 * by ±1 base unit at extreme skew, and that
 * `buy_cost(shares_for_cost(c)) <= c` — a theorem in exact arithmetic — is
 * false in fixed point about one time in ten thousand. A JavaScript double
 * would not merely differ at the edges; it would differ often enough to fire
 * spurious `SlippageExceeded` reverts on perfectly good trades.
 *
 * So the quote comes from the program itself: build the real instruction,
 * simulate it, and read the amount out of the `SharesBought` / `SharesSold`
 * event it emits. That is the exact number the real transaction will produce,
 * computed by the same code, with no second implementation to keep in sync.
 *
 * The cost is one `simulateTransaction` per quote. Cheap, and it needs no
 * signature — simulation does not require a funded account.
 */

import "server-only";

import { BN, BorshCoder, EventParser } from "@anchor-lang/core";
import {
  Keypair,
  PublicKey,
  Transaction,
  type SimulatedTransactionResponse,
} from "@solana/web3.js";

import { COMMITMENT, PROGRAM_ID, connection, idl, programFor } from "./program";
import type { Outcome } from "./actions";

const outcomeArg = (o: Outcome) => (o === "yes" ? { yes: {} } : { no: {} });

/**
 * Pull the first matching event's field out of simulation logs.
 *
 * `field` is the IDL's **snake_case** name. Anchor 1.2's `BorshCoder` decodes
 * event fields under exactly the names the IDL declares — verified against a
 * live simulation, which returns `shares_out`, not `sharesOut`. The camelCase
 * spelling is accepted as a fallback because Anchor has flipped this between
 * versions and a silent `undefined` here would surface as "no quote available"
 * rather than anything diagnosable.
 */
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
    // parseLogs is a generator and throws mid-iteration on anything it cannot
    // read. A quote that cannot be produced must surface as such, not as a
    // crash — the caller turns `null` into a readable error.
    return null;
  }
  return null;
}

/**
 * Turn a simulation failure into something a user can act on.
 *
 * Anchor puts the error code in the logs; the raw `err` object is an opaque
 * `{ InstructionError: [...] }` that means nothing to anyone.
 */
function simulationError(sim: SimulatedTransactionResponse): string {
  const logs = sim.logs ?? [];
  const anchorMsg = logs.find((l) => l.includes("Error Message:"));
  if (anchorMsg) return anchorMsg.split("Error Message:")[1]?.trim() ?? anchorMsg;
  const codeLine = logs.find((l) => l.includes("Error Code:"));
  if (codeLine) return codeLine.trim();
  return "Simulation failed";
}

async function simulate(
  trader: Keypair,
  instruction: Awaited<ReturnType<typeof buildBuy>>,
): Promise<SimulatedTransactionResponse> {
  const conn = connection();
  const { blockhash } = await conn.getLatestBlockhash(COMMITMENT);
  const tx = new Transaction({
    blockhash,
    lastValidBlockHeight: 0,
    feePayer: trader.publicKey,
  }).add(instruction);
  const res = await conn.simulateTransaction(tx, [trader]);
  return res.value;
}

async function buildBuy(input: QuoteBuyInput) {
  const program = programFor(input.trader);
  return program.methods
    .buyShares(
      outcomeArg(input.outcome),
      new BN(input.collateral.toString()),
      new BN(0), // no floor while quoting: we want the number, not a guard
    )
    .accounts({
      buyer: input.trader.publicKey,
      market: input.market,
      position: input.position,
      vault: input.vault,
      buyerTokenAccount: input.traderAta,
    })
    .instruction();
}

export interface QuoteBuyInput {
  trader: Keypair;
  market: PublicKey;
  outcome: Outcome;
  collateral: bigint;
  traderAta: PublicKey;
  vault: PublicKey;
  position: PublicKey;
}

/** Shares the market would mint for `collateral`, per the program itself. */
export async function quoteBuy(input: QuoteBuyInput): Promise<bigint> {
  const ix = await buildBuy(input);
  const sim = await simulate(input.trader, ix);
  if (sim.err) throw new Error(simulationError(sim));

  const shares = readEventField(sim, "SharesBought", "shares_out");
  if (shares === null) {
    throw new Error("Could not read a quote from the simulation");
  }
  return shares;
}

export interface QuoteSellInput {
  trader: Keypair;
  market: PublicKey;
  outcome: Outcome;
  shares: bigint;
  traderAta: PublicKey;
  vault: PublicKey;
  position: PublicKey;
}

/** Collateral the market would return for `shares`. */
export async function quoteSell(input: QuoteSellInput): Promise<bigint> {
  const program = programFor(input.trader);
  const ix = await program.methods
    .sellShares(
      outcomeArg(input.outcome),
      new BN(input.shares.toString()),
      new BN(0),
    )
    .accounts({
      seller: input.trader.publicKey,
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
