/**
 * /api/groups/[groupId]/markets — list markets in a group, or create one.
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { newId } from "@/lib/ids";
import { getCurrentUser } from "@/lib/session";
import { toMarketView } from "@/lib/markets";
import type { Market } from "@/types";

export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/groups/[groupId]/markets">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { groupId } = await ctx.params;
  const group = db.getGroup(groupId);
  if (!group?.memberIds.includes(user.id)) {
    return fail("Group not found", 404);
  }

  const markets = db.listMarketsForGroup(groupId).map(toMarketView);
  return ok({ markets });
}

interface CreateMarketBody {
  title: string;
  description?: string;
  expiresAt: number;
}

export async function POST(
  req: Request,
  ctx: RouteContext<"/api/groups/[groupId]/markets">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { groupId } = await ctx.params;
  const group = db.getGroup(groupId);
  if (!group?.memberIds.includes(user.id)) {
    return fail("Group not found", 404);
  }

  const body = await readJson<CreateMarketBody>(req);
  if (!body?.title?.trim()) return fail("Market title is required");

  const expiresAt =
    typeof body.expiresAt === "number" && body.expiresAt > Date.now()
      ? body.expiresAt
      : Date.now() + 1000 * 60 * 60 * 24; // default: 24h

  const market: Market = {
    id: newId("m"),
    groupId,
    title: body.title.trim(),
    description: body.description?.trim() || undefined,
    createdBy: user.id,
    createdAt: Date.now(),
    expiresAt,
    status: "open",
  };
  db.createMarket(market);

  // TODO(sponsor/SMS): notify group members with a link to this market.
  return ok({ market: toMarketView(market) }, { status: 201 });
}
