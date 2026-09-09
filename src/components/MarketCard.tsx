"use client";

import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { OddsBar } from "@/components/OddsBar";
import { Countdown, useNow } from "@/components/Countdown";
import type { MarketView } from "@/types";

/** Summary card for a market in a group's list. */
export function MarketCard({ market }: { market: MarketView }) {
  const now = useNow();
  const live = market.status === "open" && market.expiresAt > now;

  const resolvedTint =
    market.status === "resolved"
      ? market.outcome === "yes"
        ? "border-yes/35 bg-yes/10"
        : "border-no/35 bg-no/10"
      : "hover:border-brand/50";
  return (
    <Link href={`/markets/${market.id}`} className="block">
      <Card className={`transition ${resolvedTint}`}>
        <div className="mb-3 grid grid-cols-[1fr_auto_1fr] items-start gap-2">
          <h3 className="min-w-0 font-display text-lg font-bold leading-snug tracking-wide">
            {market.title}
          </h3>
          <span className="pt-0.5 text-center font-display text-xs font-bold tabular-nums tracking-wider text-brand">
            {market.status !== "resolved" && (
              <Countdown expiresAt={market.expiresAt} />
            )}
          </span>
          <div className="justify-self-end">
            {live && (
              <span className="shrink-0 rounded-md bg-brand px-2 py-0.5 font-display text-[10px] font-bold tracking-widest text-white">
                LIVE
              </span>
            )}
          </div>
        </div>
        {market.status === "resolved" && market.resolutionImageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={market.resolutionImageUrl}
            alt=""
            className="mb-3 h-28 w-full rounded-xl object-cover"
          />
        )}
        <OddsBar pool={market.pool} />
        <div className="mt-3 flex items-center justify-between text-xs text-muted">
          <span>{market.pool.total.toLocaleString()} in the pool</span>
          <span>
            {market.bets.length} bet{market.bets.length === 1 ? "" : "s"}
          </span>
        </div>
      </Card>
    </Link>
  );
}
