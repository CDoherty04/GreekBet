import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { OddsBar } from "@/components/OddsBar";
import type { MarketView } from "@/types";

const STATUS_LABEL: Record<MarketView["status"], string> = {
  open: "Open",
  resolving: "Resolving…",
  resolved: "Resolved",
};

/** Summary card for a market in a group's list. */
export function MarketCard({ market }: { market: MarketView }) {
  return (
    <Link href={`/markets/${market.id}`} className="block">
      <Card className="transition hover:border-brand/60">
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="font-semibold leading-snug">{market.title}</h3>
          <StatusBadge status={market.status} outcome={market.outcome} />
        </div>
        <OddsBar pool={market.pool} />
        <p className="mt-3 text-xs text-muted">
          🪙 {market.pool.total.toLocaleString()} in the pool ·{" "}
          {market.bets.length} bet{market.bets.length === 1 ? "" : "s"}
        </p>
      </Card>
    </Link>
  );
}

function StatusBadge({
  status,
  outcome,
}: {
  status: MarketView["status"];
  outcome?: MarketView["outcome"];
}) {
  if (status === "resolved") {
    const won = outcome === "yes";
    return (
      <span
        className={[
          "shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold",
          won ? "bg-yes/15 text-yes" : "bg-no/15 text-no",
        ].join(" ")}
      >
        {outcome?.toUpperCase()}
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold text-muted">
      {STATUS_LABEL[status]}
    </span>
  );
}
