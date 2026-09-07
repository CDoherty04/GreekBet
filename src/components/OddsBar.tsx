import { formatProb } from "@/lib/markets";
import type { MarketPool } from "@/types";

/** Horizontal YES/NO odds bar derived from the market pool. */
export function OddsBar({ pool }: { pool: MarketPool }) {
  const yesPct = Math.round(pool.yesProb * 100);
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm font-semibold">
        <span className="text-yes">YES {formatProb(pool.yesProb)}</span>
        <span className="text-no">{formatProb(pool.noProb)} NO</span>
      </div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-no/30">
        <div className="h-full bg-yes" style={{ width: `${yesPct}%` }} />
      </div>
    </div>
  );
}
