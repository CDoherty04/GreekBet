/**
 * /api/markets/[marketId]/reclaim — prepare an unsigned subsidy reclaim for Privy.
 *
 * Only the on-chain market creator (who seeded the vault) may reclaim
 * `vault − remaining winning shares`. Remaining is summed from unredeemed
 * positions so pre-upgrade markets with a stale on-chain `q_win` still work.
 */

import { PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";

import { db } from "@/lib/store";
import { fail, ok } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { buildReclaimSubsidyTx } from "@/lib/chain/actions";
import { connection } from "@/lib/chain/program";
import {
  getChainMarket,
  type ChainMarket,
} from "@/lib/chain/projection";
import { onChainMessage } from "@/app/api/groups/[groupId]/markets/route";

/** Winning shares still sitting in unredeemed positions. */
function remainingWinningShares(chain: ChainMarket): bigint {
  if (!chain.winningOutcome) return 0n;
  let total = 0n;
  for (const p of Object.values(chain.positions)) {
    if (p.redeemed) continue;
    total += BigInt(
      chain.winningOutcome === "yes" ? p.yesShares : p.noShares,
    );
  }
  return total;
}

export async function POST(
  _req: Request,
  ctx: RouteContext<"/api/markets/[marketId]/reclaim">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);
  if (!user.walletAddress) return fail("No wallet linked", 400);

  const { marketId } = await ctx.params;
  const meta = await db.getMarket(marketId);
  if (!meta) return fail("Market not found", 404);

  const chain = await getChainMarket(marketId);
  if (!chain) return fail("Market is not indexed yet", 409);
  if (chain.status !== "resolved") {
    return fail("This market has not been resolved yet", 409);
  }
  if (chain.creator !== user.walletAddress) {
    return fail("Only the market creator can reclaim subsidy", 403);
  }

  const remaining = remainingWinningShares(chain);
  // Prefer the live vault — event-fold volume lags SubsidyReclaimed.
  let vaultBal = BigInt(chain.volume);
  try {
    const vault = await getAccount(connection(), new PublicKey(chain.vault));
    vaultBal = BigInt(vault.amount.toString());
  } catch {
    // Fall back to the projection fold.
  }
  const residual = vaultBal - remaining;
  if (residual <= 0n) {
    return fail("Nothing to reclaim", 409);
  }

  try {
    const { transaction } = await buildReclaimSubsidyTx({
      creator: new PublicKey(user.walletAddress),
      market: new PublicKey(marketId),
      remainingWinningShares: remaining.toString(),
    });
    return ok({ transaction, amount: residual.toString() });
  } catch (err) {
    return fail(onChainMessage(err), 502);
  }
}
