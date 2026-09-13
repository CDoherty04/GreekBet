/**
 * POST /api/agent/markets/[marketId]/quote — simulate a trade for an agent user.
 */

import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

import { fail, ok, readJson } from "@/lib/http";
import { requireAgentApiKey } from "@/lib/agent/auth";
import { loadAgentMarketForUser, loadAgentUser } from "@/lib/agent/markets";
import { getChainMarket } from "@/lib/chain/projection";
import { quoteBuy, quoteSell } from "@/lib/chain/quote";
import { derivePosition, deriveVault } from "@/lib/chain/pdas";
import { COLLATERAL_MINT, UNIT } from "@/lib/chain/config";
import type { Side } from "@/types";

interface QuoteBody {
  userId: string;
  side: Side;
  action: "buy" | "sell";
  amount: string;
}

export async function POST(
  req: Request,
  ctx: RouteContext<"/api/agent/markets/[marketId]/quote">,
) {
  const denied = requireAgentApiKey(req);
  if (denied) return denied;

  const body = await readJson<QuoteBody>(req);
  if (!body?.userId) return fail("userId is required");
  if (body.side !== "yes" && body.side !== "no") {
    return fail("side must be 'yes' or 'no'");
  }
  if (body.action !== "buy" && body.action !== "sell") {
    return fail("action must be 'buy' or 'sell'");
  }

  const user = await loadAgentUser(body.userId);
  if (user instanceof Response) return user;
  if (!user.walletAddress) return fail("No wallet linked", 400);

  const { marketId } = await ctx.params;
  const loaded = await loadAgentMarketForUser(marketId, user.id);
  if (loaded instanceof Response) return loaded;

  const chain = await getChainMarket(marketId);
  if (!chain) return fail("Market is not indexed yet", 409);

  let amount: bigint;
  try {
    amount = BigInt(body.amount);
  } catch {
    return fail("amount must be an integer string of base units");
  }
  if (amount <= 0n) return ok({ received: "0", avgPrice: "0" });

  try {
    const market = new PublicKey(marketId);
    const trader = new PublicKey(user.walletAddress);
    const [vault] = deriveVault(market);
    const [position] = derivePosition(market, trader);
    const mint = new PublicKey(chain.collateralMint || COLLATERAL_MINT);
    const traderAta = await getAssociatedTokenAddress(mint, trader, true);

    const received =
      body.action === "sell"
        ? await quoteSell({
            trader,
            market,
            outcome: body.side,
            shares: amount,
            traderAta,
            vault,
            position,
          })
        : await quoteBuy({
            trader,
            market,
            outcome: body.side,
            collateral: amount,
            traderAta,
            vault,
            position,
          });

    const avgPrice =
      body.action === "buy"
        ? received > 0n
          ? ((amount * BigInt(UNIT)) / received).toString()
          : "0"
        : amount > 0n
          ? ((received * BigInt(UNIT)) / amount).toString()
          : "0";

    return ok({ received: received.toString(), avgPrice });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not quote";
    return fail(msg, 422);
  }
}
