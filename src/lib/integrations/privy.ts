/**
 * Privy — embedded wallet integration (STUB, now Solana-shaped).
 *
 * Bounty: best financial flow. Wallets are created automatically at signup
 * (from just a selfie + phone number) — the user never sees seed phrases.
 *
 * ## What changed and why
 *
 * This previously returned a random **EVM** address (`0x…`). Markets settle on
 * **Solana**, so such an address could never sign a transaction or own a token
 * account — it was display-only, which was fine while balances were internal
 * play tokens and is not fine now that trades are real.
 *
 * It now provisions a genuine Solana keypair via `src/lib/chain/wallet.ts`. The
 * key is held **server-side**: that is custodial, deliberately, because there is
 * no browser signer until real Privy is wired up, and it preserves the
 * "no seed phrase" onboarding the product is built around.
 *
 * TODO(real): swap the body for Privy's server SDK with Solana embedded
 * wallets. The signature below is unchanged, and nothing above this module
 * touches a secret key — callers only ever see the address.
 */

import "server-only";

import { keypairFor } from "@/lib/chain/wallet";

export interface Wallet {
  address: string;
  /** Which provider created the wallet (for display/debugging). */
  provider: "privy";
}

/**
 * Provision an embedded wallet for a user.
 *
 * Deterministic per `userId`: calling it again returns the same address rather
 * than orphaning the previous one along with any funds in it.
 */
export async function createWallet(userId: string): Promise<Wallet> {
  const keypair = keypairFor(userId);
  return { address: keypair.publicKey.toBase58(), provider: "privy" };
}

/** Short display form, e.g. "7xKX…gAsU". */
export function shortAddress(address: string): string {
  if (!address) return "";
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
