/**
 * Privy server client — access-token verification and user lookups.
 *
 * Auth and embedded Solana wallets live in Privy. This module is the server
 * half: verify the Bearer token on API routes and (optionally) fetch the
 * Privy user when we need linked phone / wallet metadata.
 */

import "server-only";

import { PrivyClient } from "@privy-io/node";

let client: PrivyClient | null = null;

export function privyConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_PRIVY_APP_ID && process.env.PRIVY_APP_SECRET,
  );
}

export function privy(): PrivyClient {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("Privy is not configured (NEXT_PUBLIC_PRIVY_APP_ID / PRIVY_APP_SECRET)");
  }
  client ??= new PrivyClient({ appId, appSecret });
  return client;
}

export interface VerifiedPrivyUser {
  privyId: string;
}

/** Verify a Privy access token; throws if missing/invalid. */
export async function verifyAccessToken(
  accessToken: string | null | undefined,
): Promise<VerifiedPrivyUser> {
  if (!accessToken) throw new Error("Missing access token");
  const claims = await privy().utils().auth().verifyAccessToken(accessToken);
  return { privyId: claims.user_id };
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

export interface Wallet {
  address: string;
  provider: "privy";
}

/** Short display form, e.g. "7xKX…gAsU". */
export function shortAddress(address: string): string {
  if (!address) return "";
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
