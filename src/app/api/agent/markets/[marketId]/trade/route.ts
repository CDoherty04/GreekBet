/**
 * POST /api/agent/markets/[marketId]/trade — execute a buy/sell on chain.
 *
 * `userId` authorizes market access (group membership). The trade is signed
 * and sent with the server-held agent trader wallet so Bazantic Recipes can
 * complete without a Privy confirmation step. Positions accrue to that wallet.
 */

import { PublicKey } from "@solana/web3.js";

import { fail, ok, readJson } from "@/lib/http";
import { requireAgentApiKey } from "@/lib/agent/auth";
import { loadAgentMarketForUser, loadAgentUser } from "@/lib/agent/markets";
import { executeBuyShares, executeSellShares } from "@/lib/chain/actions";
import { agentTraderKeypair } from "@/lib/chain/wallet";
import { getChainMarket } from "@/lib/chain/projection";
import { onChainMessage } from "@/app/api/groups/[groupId]/markets/route";
import type { Side } from "@/types";

interface TradeBody {
  userId: string;
  side: Side;
  action: "buy" | "sell";
  amount: string;
  slippage?: number;
}

export async function POST(
  req: Request,
  ctx: RouteContext<"/api/agent/markets/[marketId]/trade">,
) {
  const denied = requireAgentApiKey(req);
  if (denied) return denied;

  const body = await readJson<TradeBody>(req);
  if (!body?.userId) return fail("userId is required");
  if (body.side !== "yes" && body.side !== "no") {
    return fail("side must be 'yes' or 'no'");
  }
  if (body.action !== "buy" && body.action !== "sell") {
    return fail("action must be 'buy' or 'sell'");
  }

  const user = await loadAgentUser(body.userId);
  if (user instanceof Response) return user;

  const { marketId } = await ctx.params;
  const loaded = await loadAgentMarketForUser(marketId, user.id);
  if (loaded instanceof Response) return loaded;

  const chain = await getChainMarket(marketId);
  if (!chain) {
    return fail("This market is not indexed yet — try again in a moment", 409);
  }
  if (chain.status !== "open") {
    return fail("This market is closed for trading", 409);
  }
  if (chain.closeTime * 1000 <= Date.now()) {
    return fail("This market has expired", 409);
  }
  if (loaded.market.resolution) {
    return fail("A resolution photo was submitted — trading is paused", 409);
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
    const trader = agentTraderKeypair();

    const result =
      body.action === "buy"
        ? await executeBuyShares({
            trader,
            market,
            outcome: body.side,
            collateral: amount,
            slippage,
          })
        : await executeSellShares({
            trader,
            market,
            outcome: body.side,
            shares: amount,
            slippage,
          });

    return ok({
      signature: result.signature,
      received: result.received,
      walletAddress: trader.publicKey.toBase58(),
      marketId,
      side: body.side,
      action: body.action,
      amount: body.amount,
      status: "complete",
    });
  } catch (err) {
    return fail(onChainMessage(err), 502);
  }
}
