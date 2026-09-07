/**
 * Privy — embedded wallet integration (STUB).
 *
 * Bounty: best financial flow. Wallets are created automatically at signup
 * (from just a selfie + phone number) — the user never sees seed phrases.
 *
 * TODO(real): replace with Privy server/client SDK to provision an embedded
 * wallet for the authenticated user. Keep the signature identical.
 */

export interface Wallet {
  address: string;
  /** Which provider created the wallet (for display/debugging). */
  provider: "privy";
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Provision an embedded wallet for a newly created user.
 * @param _userId the internal user id to associate the wallet with
 */
export async function createWallet(_userId: string): Promise<Wallet> {
  await delay(600);
  // STUB: a random-looking EVM address.
  const address = `0x${crypto.randomUUID().replace(/-/g, "").slice(0, 40)}`;
  return { address, provider: "privy" };
}

/** Short display form of an address, e.g. "0x1234…abcd". */
export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
