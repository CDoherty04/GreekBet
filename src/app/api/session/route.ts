/**
 * /api/session — who am I, complete onboarding, sign out.
 *
 * Auth is Privy (SMS). This route only stores the app profile (name, selfie,
 * World verification) keyed by the Privy user id, and records the Solana
 * wallet address Privy already created. New signups are auto-funded on
 * devnet from the project treasury.
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser, getPrivyId } from "@/lib/session";
import { verifySelfie } from "@/lib/integrations/world";
import { normalizePhone, isValidE164 } from "@/lib/phone";
import { fundDevnetWallet } from "@/lib/chain/devnet-fund";
import type { User } from "@/types";

export async function GET() {
  const user = await getCurrentUser();
  return ok({ user });
}

interface SignUpBody {
  name: string;
  phone: string;
  selfieDataUrl: string;
  walletAddress: string;
}

export async function POST(req: Request) {
  const privyId = await getPrivyId();
  if (!privyId) return fail("Not signed in", 401);

  const existing = db.getUser(privyId);
  if (existing) {
    const body = await readJson<{ walletAddress?: string }>(req);
    if (
      body?.walletAddress &&
      body.walletAddress !== existing.walletAddress &&
      !body.walletAddress.startsWith("0x")
    ) {
      const updated = db.updateUser(privyId, {
        walletAddress: body.walletAddress,
      });
      void fundDevnetWallet(body.walletAddress).catch(() => {});
      return ok({ user: updated ?? existing });
    }
    return ok({ user: existing });
  }

  const body = await readJson<SignUpBody>(req);
  if (!body?.name || !body?.phone || !body?.selfieDataUrl || !body?.walletAddress) {
    return fail("name, phone, selfieDataUrl and walletAddress are required");
  }
  if (body.walletAddress.startsWith("0x")) {
    return fail("A Solana wallet address is required");
  }

  const phone = normalizePhone(body.phone);
  if (!isValidE164(phone)) return fail("Invalid phone number");

  const verification = await verifySelfie(body.selfieDataUrl);
  if (!verification.verified) {
    return fail("Selfie verification failed", 422);
  }

  const user: User = {
    id: privyId,
    name: body.name.trim(),
    phone,
    avatarUrl: body.selfieDataUrl,
    walletAddress: body.walletAddress,
    worldId: verification.worldId,
    verified: true,
    createdAt: Date.now(),
  };
  db.createUser(user);

  let funded: Awaited<ReturnType<typeof fundDevnetWallet>> | null = null;
  try {
    funded = await fundDevnetWallet(body.walletAddress);
  } catch (err) {
    console.error("auto-fund failed", err);
  }

  return ok({
    user,
    funded: funded?.ok ?? false,
    fundError: funded && !funded.ok ? funded.reason : undefined,
    mint: funded?.mint,
  });
}

export async function DELETE() {
  return ok({ ok: true as const });
}
