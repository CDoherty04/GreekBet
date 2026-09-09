/**
 * PDA derivation.
 *
 * ## The market PDA cannot be auto-derived by Anchor
 *
 * Its third seed is `sha256(question)`, and Anchor's IDL has no way to express
 * a hashed seed — the `market` account therefore carries no `pda` metadata and
 * `.accounts()` will not fill it in. Every caller derives it explicitly, here.
 *
 * The hash is over the question's **raw UTF-8 bytes**: no normalisation, no
 * length prefix, no lowercasing. It must match `hash_question` in the program's
 * `state.rs` byte for byte or the derived address is simply a different account.
 *
 * `vault` and `position` do carry full `pda` metadata and resolve automatically,
 * but they are derived here too so server code can read them without a Program
 * instance.
 */

import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";

import { PROGRAM_ID } from "./config";

export const MARKET_SEED = Buffer.from("market");
export const VAULT_SEED = Buffer.from("vault");
export const POSITION_SEED = Buffer.from("position");

/** SHA-256 of the question's raw UTF-8 bytes. */
export function questionHash(question: string): Buffer {
  return createHash("sha256").update(Buffer.from(question, "utf8")).digest();
}

export function deriveMarket(
  creator: PublicKey,
  question: string,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MARKET_SEED, creator.toBuffer(), questionHash(question)],
    PROGRAM_ID,
  );
}

export function deriveVault(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED, market.toBuffer()], PROGRAM_ID);
}

export function derivePosition(
  market: PublicKey,
  owner: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POSITION_SEED, market.toBuffer(), owner.toBuffer()],
    PROGRAM_ID,
  );
}
