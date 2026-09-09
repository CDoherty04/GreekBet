/**
 * Session handling (server-side).
 *
 * Dead simple for the hackathon: a signed-in user is identified by their
 * user id stored in an httpOnly cookie. No passwords — identity comes from
 * the World Selfie Check at signup.
 *
 * LOOKING AHEAD: swap the cookie value for a real session token / JWT and
 * verify it here; callers (`getCurrentUser`) won't need to change.
 */

import { cookies } from "next/headers";
import { db } from "@/lib/store";
import type { User } from "@/types";

export const SESSION_COOKIE = "gb_uid";

/** Read the current user from the session cookie, or `null` if signed out. */
export async function getCurrentUser(): Promise<User | null> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (!id) return null;
  return db.getUser(id) ?? null;
}

/** Cookie options shared by sign-in / sign-out. */
export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 30, // 30 days
};
