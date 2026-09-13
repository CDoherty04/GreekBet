/**
 * POST /api/agent/users/[userId]/fund — top up the user's wallet (devnet).
 */

import { fail, ok } from "@/lib/http";
import { requireAgentApiKey } from "@/lib/agent/auth";
import { loadAgentUser } from "@/lib/agent/markets";
import { fundDevnetWallet } from "@/lib/chain/devnet-fund";

export async function POST(
  req: Request,
  ctx: RouteContext<"/api/agent/users/[userId]/fund">,
) {
  const denied = requireAgentApiKey(req);
  if (denied) return denied;

  const { userId } = await ctx.params;
  const user = await loadAgentUser(userId);
  if (user instanceof Response) return user;
  if (!user.walletAddress) return fail("No wallet linked", 400);

  try {
    const result = await fundDevnetWallet(user.walletAddress);
    if (!result.ok) return fail(result.reason ?? "Fund failed", 502);
    return ok({
      ...result,
      walletAddress: user.walletAddress,
      note: "Devnet faucet via project treasury. Not part of the Bazantic Recipe core path.",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Fund failed";
    return fail(msg, 502);
  }
}
