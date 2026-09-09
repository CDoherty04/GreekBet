/**
 * /api/markets/[marketId]/resolve — owner submits a photo for AI analysis.
 *
 * Does not settle. Stores the photo + AI prediction so the owner can confirm
 * yes/no (the human voting layer; later this can be a 3/4 member majority).
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { toMarketView } from "@/lib/markets";
import { matchFace } from "@/lib/integrations/world";
import { resolveFromImage } from "@/lib/integrations/resolver";

interface AnalyzeBody {
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
  if (group.ownerId !== user.id) {
    return fail("Only the group owner can resolve this event", 403);
  }
  if (market.status === "resolved") {
    return fail("Market is already resolved", 409);
  }

  const body = await readJson<AnalyzeBody>(req);
  if (!body?.imageDataUrl) return fail("imageDataUrl is required");

  db.updateMarket(marketId, { status: "resolving" });

  const faceMatch = await matchFace(user.avatarUrl, body.imageDataUrl);
  const prediction = await resolveFromImage(market.title, body.imageDataUrl);

  const updated = db.updateMarket(marketId, {
    status: "resolving",
    resolutionImageUrl: body.imageDataUrl,
    resolutionNote: prediction.description,
    aiPrediction: prediction.outcome,
    aiConfidence: prediction.confidence,
  })!;

  return ok({
    market: toMarketView(updated),
    prediction: {
      outcome: prediction.outcome,
      confidence: prediction.confidence,
      description: prediction.description,
    },
    faceMatch,
  });
}
