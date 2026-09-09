/**
 * /api/markets/[marketId] — one market: off-chain metadata joined to the
 * on-chain LMSR state the indexer has projected.
 *
 * `marketId` is the market PDA.
 */

import { db } from "@/lib/store";
import { fail, ok } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { toMarketView } from "@/lib/markets";
import { getChainMarket } from "@/lib/chain/projection";

export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/markets/[marketId]">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { marketId } = await ctx.params;
  const market = db.getMarket(marketId);
  if (!market) return fail("Market not found", 404);

  const group = db.getGroup(market.groupId);
  if (!group?.memberIds.includes(user.id)) {
    return fail("Market not found", 404);
  }

  return ok({
    market: toMarketView(
      market,
      getChainMarket(marketId),
      user.walletAddress,
    ),
  });
}
