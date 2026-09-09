/**
 * /api/markets/[marketId]/resolve — settle a market from an uploaded photo.
 *
 * The headline recipe, chaining sponsors end to end:
 *   1. World  → face-match the uploader against their signup selfie, so a real,
 *      verified human vouched for the photo.
 *   2. Resolver (Bazantic) → describe → sanitize → decide yes/no.
 *   3. **On-chain settlement** → crank the market closed if needed, then write
 *      the winning outcome with the resolver authority.
 *
 * Step 3 replaces the old parimutuel payout loop. Nothing is credited here:
 * winners hold shares that redeem 1:1 from the market's vault, and they claim
 * them themselves via `/redeem`. The app cannot pay anyone — only the program
 * can move collateral, which is the point of it being non-custodial.
 *
 * The resolver is a bare pubkey the program checks and nothing more, so this
 * pipeline is exactly the "pluggable authority" seam it was designed for.
 */

import { PublicKey } from "@solana/web3.js";

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { toMarketView } from "@/lib/markets";
import { matchFace } from "@/lib/integrations/world";
import { resolveFromImage } from "@/lib/integrations/resolver";
import { closeMarket, resolveMarket } from "@/lib/chain/actions";
import { getChainMarket, projection } from "@/lib/chain/projection";
import { feePayerKeypair, resolverKeypair } from "@/lib/chain/wallet";
import { onChainMessage } from "@/app/api/groups/[groupId]/markets/route";

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
  const resolution = await resolveFromImage(meta.title, body.imageDataUrl);

  // 3) Settle on chain.
  try {
    const market = new PublicKey(marketId);
    const resolver = resolverKeypair();
    const payer = feePayerKeypair();

    // `resolve_market` requires `Closed`, and closing requires `close_time` to
    // have passed. Cranking here is permissionless by design, so anyone can do
    // it — but it genuinely cannot be done early, and saying so plainly beats
    // surfacing the program's raw error.
    if (chain.status === "open") {
      if (chain.closeTime * 1000 > Date.now()) {
        return fail(
          "This market cannot be resolved until its close time has passed",
          409,
        );
      }
      await closeMarket({ payer, market });
    }

    const signature = await resolveMarket({
      resolver,
      payer,
      market,
      outcome: resolution.outcome,
    });

    const updated = db.updateMarket(marketId, {
      resolutionImageUrl: body.imageDataUrl,
      resolutionNote: resolution.description,
    })!;

    // Re-read: `resolve` just changed chain state, and the indexer may not have
    // caught up, so the returned view can still show the market as closed.
    projection();

    return ok({
      market: toMarketView(
        updated,
        getChainMarket(marketId),
        user.walletAddress,
      ),
      outcome: resolution.outcome,
      description: resolution.description,
      faceMatch,
      signature,
    });
  } catch (err) {
    return fail(onChainMessage(err), 502);
  }
}
