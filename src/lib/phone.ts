/**
 * Phone number parsing for signup / OTP.
 *
 * Traditional E.164 regex only — no libphonenumber. We normalize common
 * US-style input (`(555) 123-4567`, `+1 555 123 4567`) into `+15551234567`.
 */

/** E.164: + then 8–15 digits, first digit 1–9. */
const E164 = /^\+[1-9]\d{7,14}$/;

/** Strip formatting and produce a best-effort E.164 string. */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (hasPlus) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export function isValidE164(phone: string): boolean {
  return E164.test(phone);
}

/** Human-readable validation error, or null if the number is usable. */
export function phoneError(raw: string): string | null {
  if (!raw.trim()) return "Enter a phone number";
  const normalized = normalizePhone(raw);
  if (!isValidE164(normalized)) {
    return "Use a valid number with country code, e.g. +1 555 123 4567";
  }
  return null;
}
