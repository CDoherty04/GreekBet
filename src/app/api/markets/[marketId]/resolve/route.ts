/**
 * /api/markets/[marketId]/resolve — settle a market from an uploaded photo.
 *
 * This is the headline "recipe" that chains sponsors end to end:
 *   1. World  → face-match the uploader against their signup selfie, so we
 *      know a real, verified human vouched for the photo.
 *   2. Resolver (Bazantic) → describe → sanitize → decide yes/no.
 *   3. Parimutuel settlement → pay winners their share back in tokens.
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { computePayouts, toMarketView } from "@/lib/markets";
import { matchFace } from "@/lib/integrations/world";
import { resolveFromImage } from "@/lib/integrations/resolver";

interface ResolveBody {
  imageDataUrl: string;
}

export async function POST(
  req: Request,
  ctx: RouteContext<"/api/markets/[marketId]/resolve">,
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
  if (market.status === "resolved") {
    return fail("Market is already resolved", 409);
  }

  const body = await readJson<ResolveBody>(req);
  if (!body?.imageDataUrl) return fail("imageDataUrl is required");

  // Mark as resolving while the pipeline runs.
  db.updateMarket(marketId, { status: "resolving" });

  // 1) World Selfie Check — confirm the uploader is really in the photo.
  const faceMatch = await matchFace(user.avatarUrl, body.imageDataUrl);

  // 2) Resolver recipe — describe → sanitize → decide.
  const resolution = await resolveFromImage(market.title, body.imageDataUrl);

  // 3) Settle: compute parimutuel payouts and credit winners.
  const bets = db.listBetsForMarket(marketId);
  const { settledBets } = computePayouts(bets, resolution.outcome);
  for (const bet of settledBets) {
    db.updateBet(bet.id, { payout: bet.payout });
    if (bet.payout && bet.payout > 0) {
      const owner = db.getUser(bet.userId);
      if (owner) db.updateUser(owner.id, { balance: owner.balance + bet.payout });
    }
  }

  const resolved = db.updateMarket(marketId, {
    status: "resolved",
    outcome: resolution.outcome,
    resolutionImageUrl: body.imageDataUrl,
    resolutionNote: resolution.description,
  })!;

  return ok({
    market: toMarketView(resolved),
    outcome: resolution.outcome,
    description: resolution.description,
    faceMatch,
  });
}
