/**
 * Agent helpers: load a user's markets and rank them for Recipes.
 */

import "server-only";

import { db } from "@/lib/store";
import { toMarketView } from "@/lib/markets";
import { projection } from "@/lib/chain/projection";
import type { Group, MarketView, User } from "@/types";
import { fail } from "@/lib/http";

export type RankBy = "spread" | "competitive" | "bets" | "volume";

export interface RankedMarket {
  market: MarketView;
  groupId: string;
  groupName: string;
  /** |yesProb − noProb| — larger = bigger price gap. */
  spread: number;
  /** Closer to 1 = nearer 50/50. */
  competitive: number;
  betCount: number;
  volume: string;
}

export async function loadAgentUser(
  userId: string,
): Promise<User | Response> {
  const user = await db.getUser(userId);
  if (!user) return fail("User not found", 404);
  return user;
}

export async function loadAgentMarketForUser(
  marketId: string,
  userId: string,
): Promise<{ market: NonNullable<Awaited<ReturnType<typeof db.getMarket>>>; group: Group } | Response> {
  const market = await db.getMarket(marketId);
  if (!market) return fail("Market not found", 404);

  const group = await db.getGroup(market.groupId);
  if (!group?.memberIds.includes(userId)) {
    return fail("Market not found", 404);
  }
  return { market, group };
}

function metrics(view: MarketView): Omit<RankedMarket, "market" | "groupId" | "groupName"> {
  const spread = Math.abs(view.pricing.yesProb - view.pricing.noProb);
  const competitive = 1 - Math.abs(view.pricing.yesProb - 0.5) * 2;
  return {
    spread,
    competitive,
    betCount: view.trades.length,
    volume: view.pricing.volume,
  };
}

function compare(a: RankedMarket, b: RankedMarket, sort: RankBy): number {
  switch (sort) {
    case "spread":
      return b.spread - a.spread;
    case "competitive":
      return b.competitive - a.competitive;
    case "bets":
      return b.betCount - a.betCount;
    case "volume":
      return Number(b.volume) - Number(a.volume);
    default:
      return b.spread - a.spread;
  }
}

/** All non-archived markets across the user's groups, ranked. */
export async function listRankedMarketsForUser(
  user: User,
  sort: RankBy = "spread",
  status: "open" | "all" = "open",
): Promise<RankedMarket[]> {
  const groups = await db.listGroupsForUser(user.id);
  const chain = await projection();
  const ranked: RankedMarket[] = [];

  for (const group of groups) {
    const metas = await db.listMarketsForGroup(group.id);
    for (const meta of metas) {
      if (meta.archived) continue;
      const view = await toMarketView(
        meta,
        chain.get(meta.address),
        user.walletAddress,
      );
      if (status === "open" && view.status !== "open") continue;
      ranked.push({
        market: view,
        groupId: group.id,
        groupName: group.name,
        ...metrics(view),
      });
    }
  }

  ranked.sort((a, b) => compare(a, b, sort));
  return ranked;
}

export function parseRankBy(value: string | null): RankBy {
  if (
    value === "spread" ||
    value === "competitive" ||
    value === "bets" ||
    value === "volume"
  ) {
    return value;
  }
  return "spread";
}
