/**
 * /api/verify/send — request a phone confirmation code.
 */

import { fail, ok, readJson } from "@/lib/http";
import { sendOtp } from "@/lib/verify";

interface Body {
  phone: string;
}

export async function POST(req: Request) {
  const body = await readJson<Body>(req);
  if (!body?.phone) return fail("phone is required");

  const result = await sendOtp(body.phone);
  if ("error" in result) return fail(result.error, result.status ?? 400);
  return ok(result);
}
