/**
 * /api/session — who am I, sign up, sign out.
 *
 * Signup is the heart of the onboarding flow: a selfie + phone number in,
 * a verified user with an auto-provisioned wallet out. It chains two
 * sponsors:
 *   1. World Selfie Check  → proof of personhood (`verifySelfie`)
 *   2. Privy               → embedded wallet (`createWallet`)
 *
 * The phone must already have passed OTP (`/api/verify/check`).
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { newId } from "@/lib/ids";
import {
  attachSessionCookie,
  clearSessionCookie,
  getCurrentUser,
} from "@/lib/session";
import { verifySelfie } from "@/lib/integrations/world";
import { createWallet } from "@/lib/integrations/privy";
import { normalizePhone, isValidE164 } from "@/lib/phone";
import { phoneIsVerified } from "@/lib/verify";
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

  const phone = normalizePhone(body.phone);
  if (!isValidE164(phone)) return fail("Invalid phone number");
  if (!phoneIsVerified(phone)) {
    return fail("Verify your phone first", 403);
  }

  // Returning user with the same phone number → just sign them back in.
  const existing = db.getUserByPhone(phone);
  if (existing) {
    return attachSessionCookie(ok({ user: existing }), existing.id);
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
    phone,
    avatarUrl: body.selfieDataUrl,
    walletAddress: wallet.address,
    worldId: verification.worldId,
    verified: true,
    createdAt: Date.now(),
  };
  db.createUser(user);

  return attachSessionCookie(ok({ user }), user.id);
}

export async function DELETE() {
  return clearSessionCookie(ok({ ok: true as const }));
}
