/**
 * Session handling (server-side).
 *
 * Identity comes from a Privy access token (`Authorization: Bearer …`).
 * The app user row is keyed by Privy user id (`did:privy:…`).
 */

import { headers } from "next/headers";
import { db } from "@/lib/store";
import { verifyAccessToken } from "@/lib/integrations/privy";
import type { User } from "@/types";

function tokenFromAuthorization(header: string | null): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

/** Read the current user from the Privy Bearer token, or `null` if unsigned. */
export async function getCurrentUser(): Promise<User | null> {
  try {
    const h = await headers();
    const token = tokenFromAuthorization(h.get("authorization"));
    if (!token) return null;
    const { privyId } = await verifyAccessToken(token);
    return db.getUser(privyId) ?? null;
  } catch {
    return null;
  }
}

/** Privy DID from the request, even before an app user row exists. */
export async function getPrivyId(): Promise<string | null> {
  try {
    const h = await headers();
    const token = tokenFromAuthorization(h.get("authorization"));
    if (!token) return null;
    const { privyId } = await verifyAccessToken(token);
    return privyId;
  } catch {
    return null;
  }
}
