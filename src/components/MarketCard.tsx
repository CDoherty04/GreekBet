"use client";

import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { OddsBar } from "@/components/OddsBar";
import { Countdown, useNow } from "@/components/Countdown";
import { formatUnits } from "@/lib/chain/config";
import type { MarketView, ResolutionStatus } from "@/types";

/** Short chip copy for an unresolved market with a resolution record. */
const RESOLUTION_CHIP: Record<ResolutionStatus, string> = {
  pending: "SETTLES AT CLOSE",
  needs_owner: "NEEDS OWNER",
  settling: "SETTLING",
  settled: "SETTLING",
  failed: "RETRYING",
};

/** Summary card for a market in a group's list. */
export function MarketCard({
  market,
  isOwner,
  busy,
  onPin,
  onArchive,
  onDelete,
}: {
  market: MarketView;
  isOwner?: boolean;
  busy?: boolean;
  onPin?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
}) {
  const now = useNow();
  const live = market.status === "open" && market.expiresAt > now;
  // A photo is in: app trading is paused, so the status replaces LIVE.
  const resolutionStatus =
    market.status !== "resolved" ? market.resolution?.status : undefined;

  // A market exists on chain the moment it is created, but the indexer needs a
  // few seconds to see it. Showing it as pending is honest; rendering 50/50
  // odds as though they were real would not be.
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
    <div>
      <Link href={`/markets/${market.address}`} className="block">
        <Card
          className={`transition ${resolvedTint} ${
            market.archived ? "opacity-70" : ""
          }`}
        >
          <div className="mb-3 grid grid-cols-[1fr_auto_1fr] items-start gap-2">
            <h3 className="min-w-0 font-display text-lg font-bold leading-snug tracking-wide">
              {market.title}
            </h3>
            <span className="pt-0.5 text-center font-display text-xs font-bold tabular-nums tracking-wider text-brand">
              {market.status !== "resolved" && (
                <Countdown expiresAt={market.expiresAt} />
              )}
            </span>
            <div className="flex flex-col items-end gap-1 justify-self-end">
              {market.pinned && (
                <span className="shrink-0 rounded-md border border-brand/40 bg-brand/15 px-2 py-0.5 font-display text-[10px] font-bold tracking-widest text-brand">
                  PINNED
                </span>
              )}
              {resolutionStatus ? (
                <span
                  className={[
                    "shrink-0 whitespace-nowrap rounded-md border px-2 py-0.5 font-display text-[10px] font-bold tracking-widest",
                    resolutionStatus === "failed"
                      ? "border-no/40 bg-no/15 text-no"
                      : resolutionStatus === "needs_owner"
                        ? "border-brand bg-brand text-white"
                        : "border-brand/40 bg-brand/15 text-brand",
                  ].join(" ")}
                >
                  {RESOLUTION_CHIP[resolutionStatus]}
                </span>
              ) : (
                live && (
                  <span className="shrink-0 rounded-md bg-brand px-2 py-0.5 font-display text-[10px] font-bold tracking-widest text-white">
                    LIVE
                  </span>
                )
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
      {isOwner && onPin && onArchive && onDelete && (
        <OwnerEventActions
          market={market}
          busy={busy}
          onPin={onPin}
          onArchive={onArchive}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

export function OwnerEventActions({
  market,
  busy,
  onPin,
  onArchive,
  onDelete,
}: {
  market: MarketView;
  busy?: boolean;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  // Deleting only forgets this app's copy of the question — the on-chain market
  // and everyone's collateral survive it. The API refuses while positions are
  // open, so the button is disabled here too rather than offering an action
  // that will just fail.
  const hasOpenPositions =
    market.myPosition !== undefined &&
    !market.myPosition.redeemed &&
    (market.myPosition.yesShares !== "0" || market.myPosition.noShares !== "0");

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
      <ActionButton disabled={busy} onClick={onPin}>
        {market.pinned ? "Unpin" : "Pin"}
      </ActionButton>
      {market.status === "resolved" && (
        <ActionButton disabled={busy} onClick={onArchive}>
          {market.archived ? "Unarchive" : "Archive"}
        </ActionButton>
      )}
      <ActionButton
        danger
        disabled={busy || hasOpenPositions}
        onClick={onDelete}
      >
        Delete
      </ActionButton>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        "font-display text-[11px] font-bold tracking-[0.16em] uppercase disabled:opacity-40",
        danger ? "text-no hover:text-no/80" : "text-muted hover:text-brand",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
