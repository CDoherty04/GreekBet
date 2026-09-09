/**
 * /api/markets/[marketId]/resolve/confirm — the owner casts the deciding vote.
 *
 * v1: group owner only. Later: 3/4 majority of members.
 *
 * This is the step that settles the market **on chain**, and it is
 * irreversible: `resolve_market` writes the winning outcome and the program
 * offers no way to change or clear it afterwards. Winners then redeem real
 * collateral 1:1 against that write.
 *
 * Nothing is paid out here. Under the old parimutuel model this route credited
 * winners from the app's own ledger; now only the program can move collateral,
 * so holders claim it themselves via `/redeem`. That is the point of the
 * program being non-custodial — the app cannot reach into the vault.
 */

import { PublicKey } from "@solana/web3.js";

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { toMarketView } from "@/lib/markets";
import { closeMarket, resolveMarket } from "@/lib/chain/actions";
import { getChainMarket, projection } from "@/lib/chain/projection";
import { feePayerKeypair, resolverKeypair } from "@/lib/chain/wallet";
import { onChainMessage } from "@/app/api/groups/[groupId]/markets/route";
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
  if (!group) return fail("Market not found", 404);
  if (group.ownerId !== user.id) {
    return fail("Only the group owner can resolve this event", 403);
  }
  if (!meta.resolutionImageUrl) {
    return fail("Take a resolution photo first", 400);
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

  try {
    const market = new PublicKey(marketId);
    const resolver = resolverKeypair();
    const payer = feePayerKeypair();

    // `resolve_market` requires `Closed`, and closing requires `close_time` to
    // have passed. Cranking is permissionless, so the server can do it — but it
    // genuinely cannot happen early, and saying so plainly beats surfacing the
    // program's raw error.
    if (chain.status === "open") {
      if (chain.closeTime * 1000 > Date.now()) {
        return fail(
          "This event cannot be resolved until its close time has passed",
          409,
        );
      }
      await closeMarket({ payer, market });
    }

    const signature = await resolveMarket({
      resolver,
      payer,
      market,
      outcome: body.outcome,
    });

    // The projection trails the transaction by however long the indexer takes,
    // so the returned view may still show the market as closed rather than
    // resolved. Re-read to narrow the window.
    projection();

    return ok({
      market: toMarketView(meta, getChainMarket(marketId), user.walletAddress),
      outcome: body.outcome,
      signature,
    });
  } catch (err) {
    return fail(onChainMessage(err), 502);
  }
}
