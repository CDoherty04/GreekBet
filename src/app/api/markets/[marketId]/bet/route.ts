/**
 * /api/markets/[marketId]/bet — place a yes/no bet with internal tokens.
 *
 * Stakes are held out of the user's balance immediately; they're paid back
 * (with winnings) when the market resolves. See `src/lib/markets.ts`.
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { newId } from "@/lib/ids";
import { getCurrentUser } from "@/lib/session";
import { toMarketView } from "@/lib/markets";
import type { Bet, Side } from "@/types";

interface BetBody {
  side: Side;
  amount: number;
}

export async function POST(
  req: Request,
  ctx: RouteContext<"/api/markets/[marketId]/bet">,
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
  if (group.ownerId === user.id) {
    return fail("Group owners referee events and cannot bet", 403);
  }
  if (market.status !== "open") {
    return fail("This market is closed for betting", 409);
  }
  if (market.expiresAt <= Date.now()) {
    return fail("This market has expired", 409);
  }

  const body = await readJson<BetBody>(req);
  if (body?.side !== "yes" && body?.side !== "no") {
    return fail("side must be 'yes' or 'no'");
  }
  const amount = Math.floor(Number(body.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return fail("amount must be a positive number");
  }
  if (amount > user.balance) {
    return fail("Not enough tokens", 402);
  }

  // Hold the stake out of the user's balance.
  db.updateUser(user.id, { balance: user.balance - amount });

  const bet: Bet = {
    id: newId("b"),
    marketId,
    userId: user.id,
    side: body.side,
    amount,
    createdAt: Date.now(),
  };
  db.createBet(bet);

  const updated = db.getUser(user.id)!;
  return ok({ market: toMarketView(market), balance: updated.balance });
}
