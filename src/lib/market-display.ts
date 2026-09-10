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
