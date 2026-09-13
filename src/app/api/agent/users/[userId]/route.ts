/**
 * GET /api/agent/users/[userId] — agent summary for a Privy user id.
 */

import { ok } from "@/lib/http";
import { requireAgentApiKey } from "@/lib/agent/auth";
import { loadAgentUser } from "@/lib/agent/markets";
import { db } from "@/lib/store";

export async function GET(
  req: Request,
  ctx: RouteContext<"/api/agent/users/[userId]">,
) {
  const denied = requireAgentApiKey(req);
  if (denied) return denied;

  const { userId } = await ctx.params;
  const user = await loadAgentUser(userId);
  if (user instanceof Response) return user;

  const groups = await db.listGroupsForUser(user.id);
  return ok({
    user: {
      id: user.id,
      name: user.name,
      walletAddress: user.walletAddress,
      privyId: user.id,
    },
    groupCount: groups.length,
    next: {
      listGroups: `/api/agent/users/${user.id}/groups`,
      listMarkets: `/api/agent/users/${user.id}/markets?sort=spread`,
      fundUser: `POST /api/agent/users/${user.id}/fund`,
      fundTrader: "POST /api/agent/trader/fund",
    },
  });
}
