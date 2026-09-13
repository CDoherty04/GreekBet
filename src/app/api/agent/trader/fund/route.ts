/**
 * POST /api/agent/trader/fund — top up the agent trader wallet (devnet).
 *
 * Bazantic Recipes trade from this server-held wallet. Call before the first
 * trade (or when SOL / collateral runs low).
 */

import { fail, ok } from "@/lib/http";
import { requireAgentApiKey } from "@/lib/agent/auth";
import { fundDevnetWallet } from "@/lib/chain/devnet-fund";
import { agentTraderKeypair } from "@/lib/chain/wallet";

export async function POST(req: Request) {
  const denied = requireAgentApiKey(req);
  if (denied) return denied;

  const trader = agentTraderKeypair();
  const walletAddress = trader.publicKey.toBase58();

  try {
    const result = await fundDevnetWallet(walletAddress);
    if (!result.ok) return fail(result.reason ?? "Fund failed", 502);
    return ok({
      ...result,
      walletAddress,
      note: "Devnet faucet for the GroupBet agent trader wallet used by Recipes.",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Fund failed";
    return fail(msg, 502);
  }
}
