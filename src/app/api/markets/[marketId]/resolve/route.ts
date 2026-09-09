/**
 * /api/markets/[marketId]/resolve — read a resolution photo with the AI.
 *
 * The headline recipe, chaining sponsors:
 *   1. World  → face-match the uploader against their signup selfie, so a real,
 *      verified human vouched for the photo.
 *   2. Resolver (Bazantic) → describe → sanitize → decide yes/no.
 *
 * **This step decides nothing.** It records the AI's reading and returns it for
 * a human to confirm at `/resolve/confirm`, which is what actually settles the
 * market on chain.
 *
 * That separation matters more now than it did off chain. Confirming writes the
 * outcome with the resolver authority, and the program makes that write one-way
 * — there is no correction, and winners redeem real collateral against it. An
 * AI reading a photo is not grounds to do that unilaterally, however confident
 * it sounds.
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { toMarketView } from "@/lib/markets";
import { matchFace } from "@/lib/integrations/world";
import { resolveFromImage } from "@/lib/integrations/resolver";
import { getChainMarket } from "@/lib/chain/projection";

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
  const meta = db.getMarket(marketId);
  if (!meta) return fail("Market not found", 404);

  const group = db.getGroup(meta.groupId);
  if (!group?.memberIds.includes(user.id)) {
    return fail("Market not found", 404);
  }

  const chain = getChainMarket(marketId);
  if (!chain) return fail("Market is not indexed yet", 409);
  if (chain.status === "resolved") {
    return fail("Market is already resolved", 409);
  }

  const body = await readJson<ResolveBody>(req);
  if (!body?.imageDataUrl) return fail("imageDataUrl is required");

  // 1) World Selfie Check — confirm the uploader is really in the photo.
  const faceMatch = await matchFace(user.avatarUrl, body.imageDataUrl);

  // 2) Resolver recipe — describe → sanitize → decide.
  const prediction = await resolveFromImage(meta.title, body.imageDataUrl);

  // Recorded as a suggestion. Nothing on chain has changed.
  const updated = db.updateMarket(marketId, {
    resolutionImageUrl: body.imageDataUrl,
    resolutionNote: prediction.description,
    aiPrediction: prediction.outcome,
    aiConfidence: prediction.confidence,
  })!;

  return ok({
    market: toMarketView(updated, chain, user.walletAddress),
    prediction: {
      outcome: prediction.outcome,
      confidence: prediction.confidence,
      description: prediction.description,
    },
    faceMatch,
  });
}
