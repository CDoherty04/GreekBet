/**
 * /api/wallet/fund — top up the signed-in Privy wallet from the treasury.
 *
 * Hackathon helper: each new Privy account gets a fresh address. Call this
 * (or rely on signup auto-fund) so SOL + test collateral land without a
 * manual `npm run fund`.
 */

import { fail, ok } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { fundDevnetWallet } from "@/lib/chain/devnet-fund";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);
  if (!user.walletAddress) return fail("No wallet linked", 400);

  try {
    const result = await fundDevnetWallet(user.walletAddress);
    if (!result.ok) return fail(result.reason ?? "Fund failed", 502);
    return ok(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Fund failed";
    return fail(msg, 502);
  }
}
