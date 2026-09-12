/**
 * /api/groups/[groupId]/markets — list markets, or prepare a create-market tx.
 *
 * Creating a market builds an **unsigned** Solana transaction. The client
 * signs and sends it with Privy, then POSTs `/markets/confirm` to store
 * off-chain metadata.
 */

import { PublicKey } from "@solana/web3.js";

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { scheduleDueSettlements, toMarketView } from "@/lib/markets";
import { buildCreateMarketTx } from "@/lib/chain/actions";
import { projection } from "@/lib/chain/projection";
import { resolverKeypair } from "@/lib/chain/wallet";
import { B_MAX, B_MIN, DEFAULT_B } from "@/lib/chain/config";

export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/groups/[groupId]/markets">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { groupId } = await ctx.params;
  const group = db.getGroup(groupId);
  if (!group?.memberIds.includes(user.id)) {
    return fail("Group not found", 404);
  }

  const chain = projection();
  const metas = db.listMarketsForGroup(groupId);
  // Settle due resolutions after responding; this list may lag by one load.
  scheduleDueSettlements(metas, (address) => chain.get(address));
  const markets = metas.map((m) =>
    toMarketView(m, chain.get(m.address), user.walletAddress),
  );
  return ok({ markets });
}

interface CreateMarketBody {
  title: string;
  description?: string;
  expiresAt: number;
  b?: number;
}

export async function POST(
  req: Request,
  ctx: RouteContext<"/api/groups/[groupId]/markets">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);
  if (!user.walletAddress) return fail("No wallet linked", 400);

  const { groupId } = await ctx.params;
  const group = db.getGroup(groupId);
  if (!group?.memberIds.includes(user.id)) {
    return fail("Group not found", 404);
  }

  const body = await readJson<CreateMarketBody>(req);
  const title = body?.title?.trim();
  if (!title) return fail("Market title is required");
  if (Buffer.byteLength(title, "utf8") > 200) {
    return fail("Question is too long (200 bytes max)");
  }

  const b = body?.b ?? DEFAULT_B;
  if (!Number.isFinite(b) || b < B_MIN || b > B_MAX) {
    return fail(`Liquidity must be between ${B_MIN} and ${B_MAX} base units`);
  }

  const expiresAt =
    typeof body?.expiresAt === "number" && body.expiresAt > Date.now()
      ? body.expiresAt
      : Date.now() + 1000 * 60 * 60 * 24;
  const closeTime = Math.floor(expiresAt / 1000);

  try {
    const built = await buildCreateMarketTx({
      creator: new PublicKey(user.walletAddress),
      resolver: resolverKeypair().publicKey,
      question: title,
      closeTime,
      b,
    });

    return ok({
      transaction: built.transaction,
      marketAddress: built.market,
      vault: built.vault,
      seedAmount: built.seedAmount,
      title,
      description: body?.description?.trim() || undefined,
      expiresAt,
    });
  } catch (err) {
    return fail(onChainMessage(err), 502);
  }
}

export function onChainMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("insufficient funds") || msg.includes("0x1")) {
    return "Not enough USDC to seed this market's liquidity";
  }
  if (msg.includes("Attempt to debit an account but found no record")) {
    return "This wallet has no devnet SOL for fees";
  }
  const anchor = msg.match(/Error Message: ([^\n.]+)/);
  if (anchor?.[1]) return anchor[1];
  return msg.split("\n")[0] ?? "On-chain transaction failed";
}
