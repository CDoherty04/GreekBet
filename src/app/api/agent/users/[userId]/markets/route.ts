/**
 * GET /api/agent/users/[userId]/markets — rank open markets across groups.
 *
 * Query: `sort=spread|competitive|bets|volume` (default spread),
 *        `status=open|all` (default open).
 */

import { ok } from "@/lib/http";
import { requireAgentApiKey } from "@/lib/agent/auth";
import {
  listRankedMarketsForUser,
  loadAgentUser,
  parseRankBy,
} from "@/lib/agent/markets";

export async function GET(
  req: Request,
  ctx: RouteContext<"/api/agent/users/[userId]/markets">,
) {
  const denied = requireAgentApiKey(req);
  if (denied) return denied;

  const { userId } = await ctx.params;
  const user = await loadAgentUser(userId);
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const sort = parseRankBy(url.searchParams.get("sort"));
  const statusParam = url.searchParams.get("status");
  const status = statusParam === "all" ? "all" : "open";

  const markets = await listRankedMarketsForUser(user, sort, status);
  return ok({
    sort,
    status,
    count: markets.length,
    markets: markets.map((row) => ({
      address: row.market.address,
      title: row.market.title,
      groupId: row.groupId,
      groupName: row.groupName,
      status: row.market.status,
      expiresAt: row.market.expiresAt,
      yesProb: row.market.pricing.yesProb,
      noProb: row.market.pricing.noProb,
      volume: row.volume,
      betCount: row.betCount,
      spread: row.spread,
      competitive: row.competitive,
      indexed: row.market.indexed,
      myPosition: row.market.myPosition ?? null,
    })),
  });
}
