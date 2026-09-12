/**
 * /api/markets/[marketId]/settle — owner's "Settle now".
 *
 * Awaits `settleMarket` for a `pending` or `failed` resolution record once the
 * market's close time has passed. The program can't close a market earlier, so
 * this refuses (409) before close rather than sending a doomed transaction.
 *
 * A failed attempt still returns 200: the outcome is in `settle`
 * (`{ state: "failed", error }`) and the record is marked `failed`.
 */

import { db } from "@/lib/store";
import { fail, ok } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { toMarketView } from "@/lib/markets";
import { settleMarket } from "@/lib/resolver/settle";
import { getChainMarket } from "@/lib/chain/projection";

export async function POST(
  _req: Request,
  ctx: RouteContext<"/api/markets/[marketId]/settle">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { marketId } = await ctx.params;
  const meta = await db.getMarket(marketId);
  if (!meta) return fail("Market not found", 404);

  const group = await db.getGroup(meta.groupId);
  if (!group?.memberIds.includes(user.id)) {
    return fail("Market not found", 404);
  }
  if (group.ownerId !== user.id) {
    return fail("Only the group owner can settle this event", 403);
  }

  const status = meta.resolution?.status;
  if (status !== "pending" && status !== "failed") {
    return fail("There is no confirmed outcome waiting to be settled", 409);
  }

  const chain = getChainMarket(marketId);
  if (!chain) return fail("Market is not indexed yet", 409);
  // Checked here, not via `isSettleDue`: that treats an already-resolved chain
  // market as due regardless of close time, so lazy loads can repair records.
  if (chain.closeTime * 1000 > Date.now()) {
    return fail(
      "This event can't be settled until its close time has passed",
      409,
    );
  }

  const settle = await settleMarket(marketId);

  return ok({
    market: await toMarketView(
      (await db.getMarket(marketId)) ?? meta,
      getChainMarket(marketId),
      user.walletAddress,
    ),
    settle,
  });
}
