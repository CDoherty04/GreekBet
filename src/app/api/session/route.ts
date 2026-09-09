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

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return ok({ user: null });

  // The demo users are seeded without a wallet, and a returning user from
  // before wallets were Solana-shaped may still hold an EVM-looking address.
  // Provision on read so nobody is left with an address that cannot sign.
  if (!user.walletAddress || user.walletAddress.startsWith("0x")) {
    const wallet = await createWallet(user.id);
    const updated = db.updateUser(user.id, { walletAddress: wallet.address });
    return ok({ user: updated ?? user });
  }
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

  // 2) Privy — auto-provision an embedded Solana wallet.
  //    Keyed by the new user id so the address is stable across sign-ins;
  //    keying it on the phone number would strand funds if the number changed.
  const id = newId("u");
  const wallet = await createWallet(id);

  const user: User = {
    id,
    name: body.name.trim(),
    phone: body.phone.trim(),
    avatarUrl: body.selfieDataUrl,
    walletAddress: wallet.address,
    worldId: verification.worldId,
    verified: true,
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
