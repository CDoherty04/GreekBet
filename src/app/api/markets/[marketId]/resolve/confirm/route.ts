/**
 * /api/markets/[marketId]/resolve/confirm — the owner chooses the outcome.
 *
 * v1: group owner only. Later: 3/4 majority of members.
 *
 * Requires a resolution record (a photo was submitted). Sets the record to
 * `pending` with `source: "owner"` — overriding the AI verdict if it differs —
 * and then settles on chain via `settleMarket` if close time has passed;
 * otherwise the response carries `{ state: "waiting" }` and a later trigger
 * settles it.
 *
 * Settlement is irreversible: `resolve_market` writes the winning outcome and
 * the program offers no way to change it. Nothing is paid out here — holders
 * redeem against that write themselves via `/redeem`.
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { toMarketView } from "@/lib/markets";
import { isSettleDue, settleMarket } from "@/lib/resolver/settle";
import type { ResolutionRecord, SettleResult } from "@/lib/resolver/types";
import { getChainMarket } from "@/lib/chain/projection";
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
  const meta = db.getMarket(marketId);
  if (!meta) return fail("Market not found", 404);

  const group = db.getGroup(meta.groupId);
  if (!group?.memberIds.includes(user.id)) {
    return fail("Market not found", 404);
  }
  if (group.ownerId !== user.id) {
    return fail("Only the group owner can resolve this event", 403);
  }

  const record = meta.resolution;
  if (!record) return fail("Take a resolution photo first", 400);
  if (record.status === "settling" || record.status === "settled") {
    return fail("This event is already being settled", 409);
  }

  const chain = getChainMarket(marketId);
  if (!chain) return fail("Market is not indexed yet", 409);
  if (chain.status === "resolved") {
    return fail("Market is already resolved", 409);
  }

  const body = await readJson<ConfirmBody>(req);
  if (body?.outcome !== "yes" && body?.outcome !== "no") {
    return fail("outcome must be 'yes' or 'no'");
  }

  const next: ResolutionRecord = {
    ...record,
    status: "pending",
    outcome: body.outcome,
    source: "owner",
    updatedAt: Date.now(),
  };
  // Drop a stale error from an earlier failed attempt; keep `attempts`.
  delete next.error;
  const updated = db.updateMarket(marketId, { resolution: next })!;

  const settle: SettleResult = isSettleDue(updated, chain)
    ? await settleMarket(marketId)
    : { state: "waiting", closesAt: chain.closeTime * 1000 };

  return ok({
    market: toMarketView(
      db.getMarket(marketId) ?? updated,
      getChainMarket(marketId),
      user.walletAddress,
    ),
    settle,
  });
}
