/**
 * /api/markets/[marketId]/redeem — prepare an unsigned redeem for Privy.
 */

import { PublicKey } from "@solana/web3.js";

import { db } from "@/lib/store";
import { fail, ok } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { buildRedeemTx } from "@/lib/chain/actions";
import { getChainMarket } from "@/lib/chain/projection";
import { onChainMessage } from "@/app/api/groups/[groupId]/markets/route";

export async function POST(
  _req: Request,
  ctx: RouteContext<"/api/markets/[marketId]/redeem">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);
  if (!user.walletAddress) return fail("No wallet linked", 400);

  const { marketId } = await ctx.params;
  const meta = await db.getMarket(marketId);
  if (!meta) return fail("Market not found", 404);

  const chain = getChainMarket(marketId);
  if (!chain) return fail("Market is not indexed yet", 409);
  if (chain.status !== "resolved") {
    return fail("This market has not been resolved yet", 409);
  }

  const position = chain.positions[user.walletAddress];
  if (!position || position.redeemed) {
    return fail("Nothing to redeem", 409);
  }

  try {
    const { transaction } = await buildRedeemTx({
      owner: new PublicKey(user.walletAddress),
      market: new PublicKey(marketId),
    });
    return ok({ transaction });
  } catch (err) {
    return fail(onChainMessage(err), 502);
  }
}
