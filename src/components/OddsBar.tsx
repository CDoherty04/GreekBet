import { formatProb } from "@/lib/markets";
import type { MarketPricing } from "@/types";

/**
 * YES/NO odds bar.
 *
 * The percentage is the LMSR's **marginal price** read from the chain, not a
 * ratio of money staked. It is the market maker's current quote — what the next
 * infinitesimal share would cost — so it moves along a bonding curve as people
 * trade rather than only when the pot's balance shifts.
 */
export function OddsBar({ pricing }: { pricing: MarketPricing }) {
  const yesPct = Math.round(pricing.yesProb * 100);
  return (
    <div>
      <div className="mb-1.5 flex justify-between font-display text-sm font-bold tracking-wide">
        <span className="text-yes">YES {formatProb(pricing.yesProb)}</span>
        <span className="text-no">{formatProb(pricing.noProb)} NO</span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-no/35">
        <div className="h-full bg-yes" style={{ width: `${yesPct}%` }} />
      </div>
    </div>
  );
}
