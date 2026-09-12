/**
 * /api/markets/[marketId] — read one market, or (owner only) pin, archive and
 * delete it.
 *
 * `marketId` is the market PDA.
 *
 * ## PATCH and DELETE are off-chain only
 *
 * Pinning, archiving and deleting act on this app's metadata. None of them can
 * touch the on-chain market: the program has no delete, collateral cannot be
 * clawed back, and a market keeps trading or stays redeemable whatever this app
 * shows. Under the old model DELETE refunded stakes from the app's ledger —
 * that is no longer possible or meaningful, so instead deletion is **refused
 * while anyone holds a position**, because dropping the metadata would strand
 * holders with a market the UI can no longer show them.
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { scheduleDueSettlements, toMarketView } from "@/lib/markets";
import { getChainMarket } from "@/lib/chain/projection";
import type { Group, Market } from "@/types";

type Loaded = { market: Market; group: Group } | { error: Response };

/** Fetch a market plus its group, enforcing membership. */
async function loadMarket(marketId: string, userId: string): Promise<Loaded> {
  const market = await db.getMarket(marketId);
  if (!market) return { error: fail("Market not found", 404) };

  const group = await db.getGroup(market.groupId);
  if (!group?.memberIds.includes(userId)) {
    // 404 rather than 403: a non-member should not learn the market exists.
    return { error: fail("Market not found", 404) };
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

  const chain = getChainMarket(marketId);
  // Settle a due resolution after responding; this view may lag by one load.
  scheduleDueSettlements([loaded.market], () => chain);

  return ok({
    market: await toMarketView(loaded.market, chain, user.walletAddress),
  });
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

  const chain = getChainMarket(marketId);

  const patch: PatchBody = {};
  if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
  if (typeof body.archived === "boolean") {
    // Status is on-chain now, so this reads the projection rather than a
    // local field. An unindexed market has no status yet and cannot be
    // archived — which is correct, since it is brand new.
    if (body.archived && chain?.status !== "resolved") {
      return fail("Only resolved events can be archived", 400);
    }
    patch.archived = body.archived;
  }

  const updated = await db.updateMarket(marketId, patch);
  return ok({
    market: await toMarketView(updated!, chain, user.walletAddress),
  });
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

  // Refusing here is the honest behaviour. Deleting only forgets the question
  // text and the group link — the vault, the shares and the redemption path all
  // survive on chain. But holders reach them *through* this app, so dropping
  // the metadata while positions are open strands them with a market they can
  // no longer see. The old model could refund stakes from its own ledger; this
  // one cannot, because the money is not the app's to move.
  const chain = getChainMarket(marketId);
  if (chain) {
    const openPositions = Object.values(chain.positions).filter(
      (p) => !p.redeemed && (p.yesShares !== "0" || p.noShares !== "0"),
    );
    if (openPositions.length > 0) {
      return fail(
        `${openPositions.length} ${
          openPositions.length === 1 ? "person still holds" : "people still hold"
        } a position in this event. It can be deleted once they have redeemed.`,
        409,
      );
    }
  }

  await db.deleteMarket(marketId);
  return ok({ ok: true as const });
}
