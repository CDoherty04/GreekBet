/**
 * ID and invite-code generation.
 *
 * Uses the Web Crypto API (available on both the Next.js server runtime and
 * modern browsers), so these helpers are safe to import from anywhere.
 */

/** A short, URL-safe unique id, e.g. "m_k3f9a2b1". */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

// Avoids ambiguous characters (0/O, 1/I) so codes are easy to read aloud.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A 6-character alphanumeric group invite code, e.g. "K7QP2M". */
export function newGroupCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(
    "",
  );
}
