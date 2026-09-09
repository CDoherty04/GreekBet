/**
 * /api/session — who am I, sign up, sign out.
 *
 * Signup is the heart of the onboarding flow: a selfie + phone number in,
 * a verified user with an auto-provisioned wallet out. It chains two
 * sponsors:
 *   1. World Selfie Check  → proof of personhood (`verifySelfie`)
 *   2. Privy               → embedded wallet (`createWallet`)
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { newId } from "@/lib/ids";
import { getCurrentUser, SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";
import { verifySelfie } from "@/lib/integrations/world";
import { createWallet } from "@/lib/integrations/privy";
import type { User } from "@/types";

/** Starting play-token balance for a new account. */
const STARTING_BALANCE = 500;

export async function GET() {
  const user = await getCurrentUser();
  return ok({ user });
}

interface SignUpBody {
  name: string;
  phone: string;
  selfieDataUrl: string;
}

export async function POST(req: Request) {
  const body = await readJson<SignUpBody>(req);
  if (!body?.name || !body?.phone || !body?.selfieDataUrl) {
    return fail("name, phone and selfieDataUrl are required");
  }

  // Returning user with the same phone number → just sign them back in.
  const existing = db.getUserByPhone(body.phone);
  if (existing) {
    const res = ok({ user: existing });
    res.headers.append(
      "Set-Cookie",
      cookie(SESSION_COOKIE, existing.id),
    );
    return res;
  }

  // 1) World Selfie Check — verify a real, unique human.
  const verification = await verifySelfie(body.selfieDataUrl);
  if (!verification.verified) {
    return fail("Selfie verification failed", 422);
  }

  // 2) Privy — auto-provision an embedded wallet.
  const wallet = await createWallet(`pending_${body.phone}`);

  const user: User = {
    id: newId("u"),
    name: body.name.trim(),
    phone: body.phone.trim(),
    avatarUrl: body.selfieDataUrl,
    walletAddress: wallet.address,
    worldId: verification.worldId,
    verified: true,
    balance: STARTING_BALANCE,
    createdAt: Date.now(),
  };
  db.createUser(user);

  const res = ok({ user });
  res.headers.append("Set-Cookie", cookie(SESSION_COOKIE, user.id));
  return res;
}

export async function DELETE() {
  const res = ok({ ok: true as const });
  res.headers.append("Set-Cookie", cookie(SESSION_COOKIE, "", 0));
  return res;
}

/** Serialize a Set-Cookie header value. */
function cookie(name: string, value: string, maxAge = sessionCookieOptions.maxAge) {
  const parts = [
    `${name}=${value}`,
    `Path=${sessionCookieOptions.path}`,
    `SameSite=Lax`,
    `HttpOnly`,
    `Max-Age=${maxAge}`,
  ];
  return parts.join("; ");
}
