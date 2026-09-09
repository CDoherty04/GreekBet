/**
 * /api/markets/[marketId]/quote — what would this trade give me?
 *
 * The UI needs this before a trade to show the shares (or collateral) the user
 * would receive and the effective price.
 *
 * The number comes from **simulating the real instruction** and reading the
 * event it emits, not from a TypeScript reimplementation of the LMSR. That
 * matters: the program computes in Q64.64 fixed point, and its own test suite
 * found that even a 60-digit reference disagrees by ±1 base unit at extreme
 * skew. A double-precision copy here would drift often enough to quote prices
 * the chain then refuses.
 */

import { PublicKey } from "@solana/web3.js";

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { getChainMarket } from "@/lib/chain/projection";
import { keypairFor } from "@/lib/chain/wallet";
import { quoteBuy, quoteSell } from "@/lib/chain/quote";
import { derivePosition, deriveVault } from "@/lib/chain/pdas";
import { COLLATERAL_MINT, UNIT } from "@/lib/chain/config";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import type { Side } from "@/types";

interface QuoteBody {
  side: Side;
  action: "buy" | "sell";
  amount: string;
}

export async function POST(
  req: Request,
  ctx: RouteContext<"/api/markets/[marketId]/quote">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { marketId } = await ctx.params;
  const meta = db.getMarket(marketId);
  if (!meta) return fail("Market not found", 404);

  const chain = getChainMarket(marketId);
  if (!chain) return fail("Market is not indexed yet", 409);

  const body = await readJson<QuoteBody>(req);
  if (body?.side !== "yes" && body?.side !== "no") {
    return fail("side must be 'yes' or 'no'");
  }

  let amount: bigint;
  try {
    amount = BigInt(body.amount);
  } catch {
    return fail("amount must be an integer string of base units");
  }
  if (amount <= 0n) return ok({ received: "0", avgPrice: "0" });

  try {
    const market = new PublicKey(marketId);
    const trader = keypairFor(user.id);
    const [vault] = deriveVault(market);
    const [position] = derivePosition(market, trader.publicKey);
    const mint = new PublicKey(chain.collateralMint || COLLATERAL_MINT);
    const traderAta = await getAssociatedTokenAddress(
      mint,
      trader.publicKey,
      true,
    );

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

    // Effective price per share, as a fraction of 1e6 — the same unit the
    // program uses for prices, so it is directly comparable to `priceYes`.
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
    // A quote failure is usually the program rejecting the trade — no
    // collateral, no shares to sell, a zero-value trade. Say so.
    const msg = err instanceof Error ? err.message : "Could not quote";
    return fail(msg, 422);
  }
}
