/**
 * /api/markets/[marketId]/trade — buy or sell outcome shares.
 *
 * Replaces the old `/bet` endpoint. Under the parimutuel model a bet was a
 * ledger entry against an internal balance; here it is a real transaction
 * against an LMSR market maker, priced on a bonding curve, and a position can
 * be **sold back before resolution** rather than being locked in.
 *
 * `marketId` is the market PDA.
 */

import { PublicKey } from "@solana/web3.js";

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { toMarketView } from "@/lib/markets";
import { buyShares, sellShares } from "@/lib/chain/actions";
import { getChainMarket } from "@/lib/chain/projection";
import { keypairFor } from "@/lib/chain/wallet";
import { onChainMessage } from "@/app/api/groups/[groupId]/markets/route";
import type { Side } from "@/types";

interface TradeBody {
  side: Side;
  action: "buy" | "sell";
  /** Base units, as a string. Collateral for a buy, shares for a sell. */
  amount: string;
  /** Fraction, e.g. 0.01 for 1%. */
  slippage?: number;
}

export async function POST(
  req: Request,
  ctx: RouteContext<"/api/markets/[marketId]/trade">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { marketId } = await ctx.params;
  const meta = db.getMarket(marketId);
  if (!meta) return fail("Market not found", 404);

  const group = db.getGroup(meta.groupId);
  if (!group?.memberIds.includes(user.id)) return fail("Market not found", 404);

  const chain = getChainMarket(marketId);
  if (!chain) {
    return fail("This market is not indexed yet — try again in a moment", 409);
  }
  // Checked here purely for a readable message; the program enforces both
  // independently and would reject the transaction regardless.
  if (chain.status !== "open") {
    return fail("This market is closed for trading", 409);
  }
  if (chain.closeTime * 1000 <= Date.now()) {
    return fail("This market has expired", 409);
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
    const trader = keypairFor(user.id);

    const result =
      body.action === "buy"
        ? await buyShares({
            trader,
            market,
            outcome: body.side,
            collateral: amount,
            slippage,
          })
        : await sellShares({
            trader,
            market,
            outcome: body.side,
            shares: amount,
            slippage,
          });

    // The projection is rebuilt from the indexer's file, which lags the
    // transaction by however long the indexer takes to see it. Returning the
    // pre-trade view would make the UI look like nothing happened, so the
    // signature is returned too and the client refetches.
    return ok({
      signature: result.signature,
      received: result.received,
      market: toMarketView(meta, getChainMarket(marketId), user.walletAddress),
    });
  } catch (err) {
    return fail(onChainMessage(err), 502);
  }
}
