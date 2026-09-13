/**
 * Pure market display helpers — safe for Client Components.
 * (Keep anything that touches `db` / chain projection out of this file.)
 */

import type { MarketView } from "@/types";

/** Human-friendly odds label, e.g. "62%". */
export function formatProb(prob: number): string {
  return `${Math.round(prob * 100)}%`;
}

/** Shares a user holds on the winning side, or "0". */
export function winningShares(view: MarketView): string {
  if (!view.outcome || !view.myPosition) return "0";
  return view.outcome === "yes"
    ? view.myPosition.yesShares
    : view.myPosition.noShares;
}

/**
 * Unspent LMSR subsidy the creator may reclaim: vault balance above still-
 * unredeemed winning shares. Uses projected `q` (decremented on redeem) as the
 * outstanding obligation. "0" when not resolved or nothing left.
 */
export function reclaimableSubsidy(view: MarketView): string {
  if (view.status !== "resolved" || !view.outcome) return "0";
  const qWin = BigInt(
    view.outcome === "yes" ? view.pricing.qYes : view.pricing.qNo,
  );
  const vault = BigInt(view.pricing.volume);
  return vault > qWin ? (vault - qWin).toString() : "0";
}
