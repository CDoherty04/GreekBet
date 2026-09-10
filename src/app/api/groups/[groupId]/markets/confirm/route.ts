/**
 * /api/groups/[groupId]/markets/confirm — record metadata after Privy send.
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { toMarketView } from "@/lib/markets";
import { getChainMarket } from "@/lib/chain/projection";
import { notifyNewEvent, requestOrigin } from "@/lib/integrations/telegram";
import type { Market } from "@/types";

interface ConfirmBody {
  marketAddress: string;
  signature: string;
  title: string;
  description?: string;
  seedAmount: string;
}

export async function POST(
  req: Request,
  ctx: RouteContext<"/api/groups/[groupId]/markets/confirm">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { groupId } = await ctx.params;
  const group = db.getGroup(groupId);
  if (!group?.memberIds.includes(user.id)) {
    return fail("Group not found", 404);
  }

  const body = await readJson<ConfirmBody>(req);
  if (!body?.marketAddress || !body?.signature || !body?.title?.trim()) {
    return fail("marketAddress, signature and title are required");
  }

  const existing = db.getMarket(body.marketAddress);
  if (existing) {
    return ok({
      market: toMarketView(
        existing,
        getChainMarket(body.marketAddress),
        user.walletAddress,
      ),
      signature: body.signature,
      seedAmount: body.seedAmount ?? "0",
    });
  }

  const title = body.title.trim();
  const market: Market = {
    address: body.marketAddress,
    groupId,
    title,
    description: body.description?.trim() || undefined,
    createdBy: user.id,
    createdAt: Date.now(),
    createSignature: body.signature,
  };
  db.createMarket(market);

  const chatIds = group.memberIds
    .map((id) => db.getUser(id)?.telegramChatId)
    .filter((id): id is string => Boolean(id));
  void notifyNewEvent({
    chatIds,
    groupName: group.name,
    title,
    url: `${requestOrigin(req)}/markets/${market.address}`,
  });

  return ok(
    {
      market: toMarketView(
        market,
        getChainMarket(body.marketAddress),
        user.walletAddress,
      ),
      signature: body.signature,
      seedAmount: body.seedAmount ?? "0",
    },
    { status: 201 },
  );
}
