/**
 * /api/markets/[marketId] — a single market with its pool + bets.
 * Owner can PATCH (pin/archive) or DELETE.
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { toMarketView } from "@/lib/markets";

async function loadMarket(marketId: string, userId: string) {
  const market = db.getMarket(marketId);
  if (!market) return { error: fail("Market not found", 404) as Response };
  const group = db.getGroup(market.groupId);
  if (!group?.memberIds.includes(userId)) {
    return { error: fail("Market not found", 404) as Response };
  }
  return { market, group };
}

export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/markets/[marketId]">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { marketId } = await ctx.params;
  const loaded = await loadMarket(marketId, user.id);
  if ("error" in loaded) return loaded.error;

  return ok({ market: toMarketView(loaded.market) });
}

interface PatchBody {
  pinned?: boolean;
  archived?: boolean;
}

export async function PATCH(
  req: Request,
  ctx: RouteContext<"/api/markets/[marketId]">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { marketId } = await ctx.params;
  const loaded = await loadMarket(marketId, user.id);
  if ("error" in loaded) return loaded.error;
  if (loaded.group.ownerId !== user.id) {
    return fail("Only the group owner can update this event", 403);
  }

  const body = await readJson<PatchBody>(req);
  if (!body) return fail("Invalid JSON");

  const patch: { pinned?: boolean; archived?: boolean } = {};
  if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
  if (typeof body.archived === "boolean") {
    if (body.archived && loaded.market.status !== "resolved") {
      return fail("Only resolved events can be archived", 400);
    }
    patch.archived = body.archived;
  }

  const updated = db.updateMarket(marketId, patch);
  return ok({ market: toMarketView(updated!) });
}

export async function DELETE(
  _req: Request,
  ctx: RouteContext<"/api/markets/[marketId]">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { marketId } = await ctx.params;
  const loaded = await loadMarket(marketId, user.id);
  if ("error" in loaded) return loaded.error;
  if (loaded.group.ownerId !== user.id) {
    return fail("Only the group owner can delete this event", 403);
  }

  // Unresolved events still hold stakes — refund them so tokens aren't lost.
  if (loaded.market.status !== "resolved") {
    for (const bet of db.listBetsForMarket(marketId)) {
      const bettor = db.getUser(bet.userId);
      if (bettor) {
        db.updateUser(bettor.id, { balance: bettor.balance + bet.amount });
      }
    }
  }

  db.deleteMarket(marketId);
  return ok({ ok: true as const });
}
