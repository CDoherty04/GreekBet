/**
 * /api/markets/[marketId]/trade — prepare an unsigned buy/sell for Privy.
 */

import { PublicKey } from "@solana/web3.js";

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { buildBuySharesTx, buildSellSharesTx } from "@/lib/chain/actions";
import { getChainMarket } from "@/lib/chain/projection";
import { onChainMessage } from "@/app/api/groups/[groupId]/markets/route";
import type { Side } from "@/types";

interface TradeBody {
  side: Side;
  action: "buy" | "sell";
  amount: string;
  slippage?: number;
}

export async function POST(
  req: Request,
  ctx: RouteContext<"/api/markets/[marketId]/trade">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);
  if (!user.walletAddress) return fail("No wallet linked", 400);

  const { marketId } = await ctx.params;
  const meta = db.getMarket(marketId);
  if (!meta) return fail("Market not found", 404);

  const group = db.getGroup(meta.groupId);
  if (!group?.memberIds.includes(user.id)) return fail("Market not found", 404);

  const chain = getChainMarket(marketId);
  if (!chain) {
    return fail("This market is not indexed yet — try again in a moment", 409);
  }
  if (chain.status !== "open") {
    return fail("This market is closed for trading", 409);
  }
  if (chain.closeTime * 1000 <= Date.now()) {
    return fail("This market has expired", 409);
  }
  // App-level pause (PLAN-2 decision 5): the submitter has seen the photo, so
  // no one trades while a verdict is hidden. The program itself still allows
  // trades until close; the owner can clear the record to resume.
  if (meta.resolution) {
    return fail("A resolution photo was submitted — trading is paused", 409);
  }

  const body = await readJson<TradeBody>(req);
  if (body?.side !== "yes" && body?.side !== "no") {
    return fail("side must be 'yes' or 'no'");
  }
  if (body.action !== "buy" && body.action !== "sell") {
    return fail("action must be 'buy' or 'sell'");
  }

  let amount: bigint;
  try {
    amount = BigInt(body.amount);
  } catch {
    return fail("amount must be an integer string of base units");
  }
  if (amount <= 0n) return fail("amount must be positive");

  const slippage =
    typeof body.slippage === "number" && body.slippage >= 0 && body.slippage < 1
      ? body.slippage
      : 0.01;

  try {
    const market = new PublicKey(marketId);
    const trader = new PublicKey(user.walletAddress);

    const result =
      body.action === "buy"
        ? await buildBuySharesTx({
            trader,
            market,
            outcome: body.side,
            collateral: amount,
            slippage,
          })
        : await buildSellSharesTx({
            trader,
            market,
            outcome: body.side,
            shares: amount,
            slippage,
          });

    return ok({
      transaction: result.transaction,
      received: result.received,
    });
  } catch (err) {
    return fail(onChainMessage(err), 502);
  }
}
