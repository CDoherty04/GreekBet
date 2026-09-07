/**
 * Market pricing + settlement logic.
 *
 * We use a simple **parimutuel** model (like horse racing / pool betting):
 * everyone's stake goes into one pot, and when the market resolves the
 * winning side splits the entire pot in proportion to their stake.
 *
 * This is deliberately simpler than an AMM/order book — no bonding curves,
 * no liquidity provision — which is the right call for a hackathon while
 * still giving realistic, dynamic "odds".
 */

import type { Bet, Market, MarketPool, MarketView, Side } from "@/types";
import { db } from "@/lib/store";

/** Sum stakes on each side and derive implied probabilities. */
export function computePool(bets: Bet[]): MarketPool {
  let yes = 0;
  let no = 0;
  for (const bet of bets) {
    if (bet.side === "yes") yes += bet.amount;
    else no += bet.amount;
  }
  const total = yes + no;
  // Before any bets, show a 50/50 market rather than dividing by zero.
  const yesProb = total === 0 ? 0.5 : yes / total;
  return { yes, no, total, yesProb, noProb: 1 - yesProb };
}

/**
 * Compute each user's payout for a resolved market.
 *
 * Winners split the whole pot proportional to their stake, so a winning
 * bettor receives `stake + share of the losing pool`.
 *
 * Edge case: if nobody bet the winning side, everyone is refunded their
 * original stake (the pot can't be split among zero winners).
 *
 * Returns a map of `userId -> total payout` and annotates each winning bet.
 */
export function computePayouts(
  bets: Bet[],
  outcome: Side,
): { payoutByUser: Map<string, number>; settledBets: Bet[] } {
  const pool = computePool(bets);
  const winningTotal = outcome === "yes" ? pool.yes : pool.no;
  const payoutByUser = new Map<string, number>();

  const settledBets = bets.map((bet) => {
    let payout = 0;
    if (winningTotal === 0) {
      // No winners on the resolved side: refund every bet.
      payout = bet.amount;
    } else if (bet.side === outcome) {
      // Winner: proportional share of the entire pot.
      payout = (bet.amount / winningTotal) * pool.total;
    }
    payout = Math.round(payout);
    payoutByUser.set(bet.userId, (payoutByUser.get(bet.userId) ?? 0) + payout);
    return { ...bet, payout };
  });

  return { payoutByUser, settledBets };
}

/** Human-friendly odds label, e.g. "62%". */
export function formatProb(prob: number): string {
  return `${Math.round(prob * 100)}%`;
}

/**
 * Assemble the full view-model for a market (market + pool + bets) that the
 * API returns to the client in a single payload.
 */
export function toMarketView(market: Market): MarketView {
  const bets = db.listBetsForMarket(market.id);
  return { ...market, bets, pool: computePool(bets) };
}
