/**
 * Phone OTP orchestration.
 *
 * Tries Telegram Gateway, then an in-app stub so the demo still works
 * without a Gateway token.
 */

import { normalizePhone, isValidE164, phoneError } from "@/lib/phone";
import {
  checkGatewayCode,
  sendGatewayCode,
  telegramGatewayConfigured,
  type VerifyChannel,
} from "@/lib/integrations/telegram";
import { verifyDb } from "@/lib/verify-store";

const OTP_TTL_MS = 120_000;
const RESEND_MS = 30_000;
const MAX_ATTEMPTS = 5;
const VERIFIED_MS = 15 * 60_000;

export interface SendOtpResult {
  phone: string;
  channel: VerifyChannel;
  expiresIn: number;
  resendIn: number;
  /** Only present for the stub channel so local demos can proceed. */
  devCode?: string;
}

export interface CheckOtpResult {
  phone: string;
  ok: true;
}

function sixDigitCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}

export function requireValidPhone(raw: string): { phone: string } | { error: string } {
  const message = phoneError(raw);
  if (message) return { error: message };
  const phone = normalizePhone(raw);
  if (!isValidE164(phone)) return { error: message ?? "Invalid phone number" };
  return { phone };
}

export async function sendOtp(raw: string): Promise<SendOtpResult | { error: string; status?: number }> {
  const parsed = requireValidPhone(raw);
  if ("error" in parsed) return parsed;
  const { phone } = parsed;

  const existing = verifyDb.getOtp(phone);
  if (existing && Date.now() - existing.sentAt < RESEND_MS) {
    const wait = Math.ceil((RESEND_MS - (Date.now() - existing.sentAt)) / 1000);
    return { error: `Wait ${wait}s before resending`, status: 429 };
  }

  const expiresAt = Date.now() + OTP_TTL_MS;

  if (telegramGatewayConfigured()) {
    const sent = await sendGatewayCode(phone);
    if ("requestId" in sent) {
      verifyDb.setOtp({
        phone,
        requestId: sent.requestId,
        channel: "telegram",
        expiresAt,
        sentAt: Date.now(),
        attempts: 0,
      });
      return { phone, channel: "telegram", expiresIn: OTP_TTL_MS / 1000, resendIn: RESEND_MS / 1000 };
    }
  }

  const code = sixDigitCode();

  verifyDb.setOtp({
    phone,
    code,
    channel: "stub",
    expiresAt,
    sentAt: Date.now(),
    attempts: 0,
  });
  return {
    phone,
    channel: "stub",
    expiresIn: OTP_TTL_MS / 1000,
    resendIn: RESEND_MS / 1000,
    devCode: code,
  };
}

export async function checkOtp(
  raw: string,
  codeRaw: string,
): Promise<CheckOtpResult | { error: string; status?: number }> {
  const parsed = requireValidPhone(raw);
  if ("error" in parsed) return parsed;
  const { phone } = parsed;

  const code = codeRaw.replace(/\D/g, "");
  if (!/^\d{4,8}$/.test(code)) return { error: "Enter the 6-digit code" };

  const pending = verifyDb.getOtp(phone);
  if (!pending) return { error: "Request a new code first", status: 400 };
  if (pending.expiresAt < Date.now()) {
    verifyDb.clearOtp(phone);
    return { error: "That code expired — request a new one", status: 400 };
  }
  if (pending.attempts >= MAX_ATTEMPTS) {
    verifyDb.clearOtp(phone);
    return { error: "Too many attempts — request a new code", status: 429 };
  }

  pending.attempts += 1;
  verifyDb.setOtp(pending);

  let valid = false;
  if (pending.channel === "telegram" && pending.requestId) {
    const checked = await checkGatewayCode(pending.requestId, code);
    valid = checked.valid;
    if (!valid && checked.error === "expired") {
      verifyDb.clearOtp(phone);
      return { error: "That code expired — request a new one", status: 400 };
    }
  } else if (pending.code) {
    valid = pending.code === code;
  }

  if (!valid) return { error: "That code isn’t right", status: 401 };

  verifyDb.clearOtp(phone);
  verifyDb.markVerified(phone, Date.now() + VERIFIED_MS);
  return { phone, ok: true };
}

export function phoneIsVerified(raw: string): boolean {
  const parsed = requireValidPhone(raw);
  if ("error" in parsed) return false;
  return verifyDb.isVerified(parsed.phone);
}
