/**
 * /api/groups/[groupId]/markets — list markets in a group, or create one.
 *
 * Creating a market is an **on-chain** action: it initialises a PDA, opens a
 * vault, and transfers the creator's LMSR subsidy (`b·ln2`) into it. The
 * off-chain row written afterwards is metadata only — the question text and
 * which group it belongs to, neither of which the program knows about.
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { toMarketView } from "@/lib/markets";
import { createMarket } from "@/lib/chain/actions";
import { getChainMarket, projection } from "@/lib/chain/projection";
import { keypairFor, resolverKeypair } from "@/lib/chain/wallet";
import { B_MAX, B_MIN, DEFAULT_B } from "@/lib/chain/config";
import type { Market } from "@/types";

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

  // One projection read for the whole list rather than per market.
  const chain = projection();
  const markets = db
    .listMarketsForGroup(groupId)
    .map((m) => toMarketView(m, chain.get(m.address), user.walletAddress));
  return ok({ markets });
}

interface CreateMarketBody {
  title: string;
  description?: string;
  expiresAt: number;
  /** LMSR liquidity in base units. Defaults to the program minimum. */
  b?: number;
}

export async function POST(
  req: Request,
  ctx: RouteContext<"/api/groups/[groupId]/markets">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { groupId } = await ctx.params;
  const group = db.getGroup(groupId);
  if (!group?.memberIds.includes(user.id)) {
    return fail("Group not found", 404);
  }

  const body = await readJson<CreateMarketBody>(req);
  const title = body?.title?.trim();
  if (!title) return fail("Market title is required");
  // The question is a PDA seed, and the program caps it at 200 UTF-8 bytes.
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

  // The program works in unix seconds and rejects a close time in the past.
  const closeTime = Math.floor(expiresAt / 1000);

  try {
    const created = await createMarket({
      creator: keypairFor(user.id),
      resolver: resolverKeypair().publicKey,
      question: title,
      closeTime,
      b,
    });

    const market: Market = {
      address: created.market,
      groupId,
      title,
      description: body?.description?.trim() || undefined,
      createdBy: user.id,
      createdAt: Date.now(),
      createSignature: created.signature,
    };
    db.createMarket(market);

    // The indexer may not have seen it yet; the view reports `indexed: false`
    // and the UI shows it as pending rather than inventing prices.
    return ok(
      {
        market: toMarketView(
          market,
          getChainMarket(created.market),
          user.walletAddress,
        ),
        signature: created.signature,
        seedAmount: created.seedAmount,
      },
      { status: 201 },
    );
  } catch (err) {
    return fail(onChainMessage(err), 502);
  }
}

/**
 * Surface the program's own error rather than a generic failure.
 *
 * The two most common are worth naming: the creator has no collateral for the
 * subsidy, or no SOL for rent and fees. Both are ordinary on devnet and are
 * useless as "Transaction failed".
 */
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
