/**
 * /api/markets/[marketId]/resolve/confirm — owner casts the deciding vote.
 *
 * v1: group owner only. Later: 3/4 majority of members.
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { computePayouts, toMarketView } from "@/lib/markets";
import type { Side } from "@/types";

interface ConfirmBody {
  outcome: Side;
}

export async function POST(
  req: Request,
  ctx: RouteContext<"/api/markets/[marketId]/resolve/confirm">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { marketId } = await ctx.params;
  const market = db.getMarket(marketId);
  if (!market) return fail("Market not found", 404);

  const group = db.getGroup(market.groupId);
  if (!group) return fail("Market not found", 404);
  if (group.ownerId !== user.id) {
    return fail("Only the group owner can resolve this event", 403);
  }
  if (market.status === "resolved") {
    return fail("Market is already resolved", 409);
  }
  if (!market.resolutionImageUrl) {
    return fail("Take a resolution photo first", 400);
  }

  const body = await readJson<ConfirmBody>(req);
  if (body?.outcome !== "yes" && body?.outcome !== "no") {
    return fail("outcome must be 'yes' or 'no'");
  }

  const bets = db.listBetsForMarket(marketId);
  const { settledBets } = computePayouts(bets, body.outcome);
  for (const bet of settledBets) {
    db.updateBet(bet.id, { payout: bet.payout });
    if (bet.payout && bet.payout > 0) {
      const owner = db.getUser(bet.userId);
      if (owner) db.updateUser(owner.id, { balance: owner.balance + bet.payout });
    }
  }

  const resolved = db.updateMarket(marketId, {
    status: "resolved",
    outcome: body.outcome,
  })!;

  return ok({ market: toMarketView(resolved), outcome: body.outcome });
}
