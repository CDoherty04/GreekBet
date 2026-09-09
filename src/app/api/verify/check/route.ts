/**
 * /api/verify/check — confirm the Telegram code.
 *
 * If that phone already has an account, signs them in.
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { attachSessionCookie } from "@/lib/session";
import { checkOtp } from "@/lib/verify";

interface Body {
  phone: string;
  code: string;
}

export async function POST(req: Request) {
  const body = await readJson<Body>(req);
  if (!body?.phone || !body?.code) return fail("phone and code are required");

  const result = await checkOtp(body.phone, body.code);
  if ("error" in result) return fail(result.error, result.status ?? 400);

  const existing = db.getUserByPhone(result.phone);
  if (existing) {
    const res = ok({ ok: true as const, phone: result.phone, user: existing });
    return attachSessionCookie(res, existing.id);
  }

  return ok({ ok: true as const, phone: result.phone, user: null });
}
