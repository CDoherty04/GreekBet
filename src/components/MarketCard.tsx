"use client";

import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { OddsBar } from "@/components/OddsBar";
import { Countdown, useNow } from "@/components/Countdown";
import { formatUnits } from "@/lib/chain/config";
import type { MarketView } from "@/types";

/** Summary card for a market in a group's list. */
export function MarketCard({ market }: { market: MarketView }) {
  const now = useNow();
  const live = market.status === "open" && market.expiresAt > now;

  // A market exists on chain the moment it is created, but the indexer needs a
  // few seconds to see it. Showing it as pending is honest; showing 50/50 odds
  // as if they were real would not be.
  if (!market.indexed) {
    return (
      <Card className="opacity-60">
        <h3 className="font-display text-lg font-bold leading-snug tracking-wide">
          {market.title}
        </h3>
        <p className="mt-2 text-xs text-muted">Confirming on chain…</p>
      </Card>
    );
  }

  const resolvedTint =
    market.status === "resolved"
      ? market.outcome === "yes"
        ? "border-yes/35 bg-yes/10"
        : "border-no/35 bg-no/10"
      : "hover:border-brand/50";
  return (
    <Link href={`/markets/${market.address}`} className="block">
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
        <OddsBar pricing={market.pricing} />
        <div className="mt-3 flex items-center justify-between text-xs text-muted">
          <span>${formatUnits(market.pricing.volume)} in the vault</span>
          <span>
            {market.trades.length} trade{market.trades.length === 1 ? "" : "s"}
          </span>
        </div>
      </Card>
    </Link>
  );
}
