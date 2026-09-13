/**
 * GET /api/agent/markets/[marketId]?userId=… — one market for an agent user.
 */

import { fail, ok } from "@/lib/http";
import { requireAgentApiKey } from "@/lib/agent/auth";
import { loadAgentMarketForUser, loadAgentUser } from "@/lib/agent/markets";
import { toMarketView } from "@/lib/markets";
import { getChainMarket } from "@/lib/chain/projection";

export async function GET(
  req: Request,
  ctx: RouteContext<"/api/agent/markets/[marketId]">,
) {
  const denied = requireAgentApiKey(req);
  if (denied) return denied;

  const userId = new URL(req.url).searchParams.get("userId");
  if (!userId) return fail("userId query param is required");

  const user = await loadAgentUser(userId);
  if (user instanceof Response) return user;

  const { marketId } = await ctx.params;
  const loaded = await loadAgentMarketForUser(marketId, user.id);
  if (loaded instanceof Response) return loaded;

  const chain = await getChainMarket(marketId);
  const view = await toMarketView(loaded.market, chain, user.walletAddress);
  return ok({
    market: view,
    group: { id: loaded.group.id, name: loaded.group.name },
  });
}
