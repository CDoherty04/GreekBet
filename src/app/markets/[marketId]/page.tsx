"use client";

/**
 * Market detail — see the odds, place a yes/no bet with tokens, and (while
 * open) resolve the market from a photo.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { BalancePill } from "@/components/BalancePill";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { OddsBar } from "@/components/OddsBar";
import { Countdown, useNow } from "@/components/Countdown";
import { useRequireUser } from "@/components/SessionProvider";
import { api } from "@/lib/api";
import { formatProb } from "@/lib/markets";
import type { MarketView, Side } from "@/types";

export default function MarketDetailPage() {
  const { marketId } = useParams<{ marketId: string }>();
  const { user, loading, setUser } = useRequireUser();
  const [market, setMarket] = useState<MarketView | null>(null);
  const [side, setSide] = useState<Side>("yes");
  const [amount, setAmount] = useState("25");
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  const load = useCallback(async () => {
    const { market } = await api.getMarket(marketId);
    setMarket(market);
  }, [marketId]);

  useEffect(() => {
    // Fetch-on-mount: load the market once we know who the user is.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (user) void load().catch(() => setError("Could not load market"));
  }, [user, load]);

  async function placeBet() {
    setPlacing(true);
    setError(null);
    try {
      const res = await api.placeBet(marketId, { side, amount: Number(amount) });
      setMarket(res.market);
      if (user) setUser({ ...user, balance: res.balance });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not place bet");
    } finally {
      setPlacing(false);
    }
  }

  if (loading || !user || !market) return <Splash />;

  const live = market.status === "open" && market.expiresAt > now;
  const isOwner = market.groupOwnerId === user.id;
  const myPayout = sumPayout(
    market.bets.filter((b) => b.userId === user.id),
  );

  return (
    <div className="flex flex-1 flex-col">
      <TopBar
        back
        centerTitle
        title={
          market.status !== "resolved" ? (
            <Countdown expiresAt={market.expiresAt} />
          ) : undefined
        }
        right={<BalancePill />}
      />
      <div className="flex-1 space-y-4 overflow-y-auto p-4 no-scrollbar">
        <div>
          <h1 className="font-display text-2xl font-extrabold uppercase leading-tight tracking-wide">
            {market.title}
          </h1>
          {market.description && (
            <p className="mt-1 text-sm text-muted">{market.description}</p>
          )}
        </div>

        <Card>
          <OddsBar pool={market.pool} />
          <div className="mt-3 flex justify-between text-xs text-muted">
            <span>🪙 {market.pool.total.toLocaleString()} pool</span>
            <span>
              {market.bets.length} bet{market.bets.length === 1 ? "" : "s"}
            </span>
          </div>
        </Card>

        {market.status === "resolved" ? (
          <ResolvedPanel market={market} myPayout={myPayout} />
        ) : isOwner && live ? (
          <Card className="text-sm text-muted">
            You&apos;re the group owner — you referee this event and can&apos;t
            bet.
          </Card>
        ) : live ? (
          <BetPanel
            side={side}
            setSide={setSide}
            amount={amount}
            setAmount={setAmount}
            balance={user.balance}
            placing={placing}
            onPlace={placeBet}
            yesProb={market.pool.yesProb}
          />
        ) : !isOwner ? (
          <Card className="text-sm text-muted">
            Betting is closed. Waiting for the owner to resolve.
          </Card>
        ) : null}

        {error && <p className="text-sm text-no">{error}</p>}

        {market.bets.length > 0 && (
          <div>
            <p className="label-hud mb-2">Bets</p>
            <div className="space-y-2">
              {market.bets.map((b) => (
                <div
                  key={b.id}
                  className="flex items-center justify-between rounded-xl border border-border bg-surface px-3 py-2 text-sm"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <BetAvatar
                      name={b.userName ?? "Someone"}
                      avatarUrl={b.userAvatarUrl}
                    />
                    <span className="truncate">
                      {b.userName ?? "Someone"}
                      {b.userId === user.id ? " · you" : ""}
                    </span>
                  </div>
                  <div className="ml-3 flex shrink-0 items-center gap-2">
                    <span
                      className={b.side === "yes" ? "text-yes" : "text-no"}
                    >
                      {b.side.toUpperCase()} · {b.amount}
                    </span>
                    {b.payout !== undefined && (
                      <span className={b.payout > 0 ? "text-yes" : "text-muted"}>
                        {b.payout > 0 ? `+${b.payout}` : "—"}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {market.status !== "resolved" && isOwner && (
        <div className="border-t border-border p-4">
          <Link href={`/markets/${marketId}/resolve`}>
            <Button variant={live ? "secondary" : "primary"}>
              {market.aiPrediction ? "Confirm result" : "Resolve with photo"}
            </Button>
          </Link>
        </div>
      )}
    </div>
  );
}

function parseAmount(raw: string): number | null {
  if (!raw.trim()) return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function amountError(raw: string, balance: number): string | null {
  if (!raw.trim()) return "Enter an amount";
  const n = parseAmount(raw);
  if (n === null) return "Enter a whole number";
  if (n > balance) return "Not enough tokens";
  return null;
}

function BetPanel({
  side,
  setSide,
  amount,
  setAmount,
  balance,
  placing,
  onPlace,
  yesProb,
}: {
  side: Side;
  setSide: (s: Side) => void;
  amount: string;
  setAmount: (n: string) => void;
  balance: number;
  placing: boolean;
  onPlace: () => void;
  yesProb: number;
}) {
  const parsed = parseAmount(amount);
  const error = amountError(amount, balance);
  return (
    <Card className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => setSide("yes")}
          className={[
            "rounded-2xl border-2 py-4 text-center transition",
            side === "yes"
              ? "border-yes bg-yes/15"
              : "border-border bg-surface-2",
          ].join(" ")}
        >
          <div className="text-lg font-display font-bold tracking-wide text-yes">YES</div>
          <div className="text-xs text-muted">{formatProb(yesProb)}</div>
        </button>
        <button
          onClick={() => setSide("no")}
          className={[
            "rounded-2xl border-2 py-4 text-center transition",
            side === "no" ? "border-no bg-no/15" : "border-border bg-surface-2",
          ].join(" ")}
        >
          <div className="text-lg font-display font-bold tracking-wide text-no">NO</div>
          <div className="text-xs text-muted">{formatProb(1 - yesProb)}</div>
        </button>
      </div>

      <label className="block">
        <span className="mb-1.5 block label-hud">
          Amount
        </span>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          name="amount"
          placeholder="25"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
          className={[
            "w-full rounded-2xl border bg-surface-2 px-4 py-3.5 text-base text-foreground outline-none",
            error ? "border-no" : "border-border focus:border-brand",
          ].join(" ")}
        />
        <span className={`mt-1.5 block text-xs ${error ? "text-no" : "text-muted"}`}>
          {error ?? `${balance.toLocaleString()} tokens available`}
        </span>
      </label>

      <Button
        variant={side === "yes" ? "yes" : "no"}
        loading={placing}
        disabled={parsed === null || parsed > balance}
        onClick={onPlace}
      >
        Bet {parsed ?? 0} on {side.toUpperCase()}
      </Button>
    </Card>
  );
}

function ResolvedPanel({
  market,
  myPayout,
}: {
  market: MarketView;
  myPayout: number;
}) {
  const won = market.outcome === "yes";
  return (
    <Card className="space-y-3">
      {market.resolutionImageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={market.resolutionImageUrl}
          alt="Resolution photo"
          className="w-full rounded-xl object-cover"
        />
      )}
      <div className="flex items-center gap-2">
        <span
          className={[
            "rounded-full px-3 py-1 text-sm font-bold",
            won ? "bg-yes/15 text-yes" : "bg-no/15 text-no",
          ].join(" ")}
        >
          Resolved {market.outcome?.toUpperCase()}
        </span>
        {myPayout > 0 && (
          <span className="text-sm font-semibold text-yes">
            You won 🪙 {myPayout}
          </span>
        )}
      </div>
      {market.resolutionNote && (
        <p className="text-sm text-muted">
          <span className="font-medium text-foreground">AI saw:</span>{" "}
          {market.resolutionNote}
        </p>
      )}
      {market.aiPrediction && (
        <p className="text-xs text-muted">
          AI predicted {market.aiPrediction.toUpperCase()} (
          {Math.round((market.aiConfidence ?? 0) * 100)}% confidence)
        </p>
      )}
    </Card>
  );
}

function BetAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
  return (
    <div className="h-7 w-7 shrink-0 overflow-hidden rounded-full border border-border bg-surface-2">
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[10px] font-bold text-muted">
          {name.charAt(0).toUpperCase()}
        </div>
      )}
    </div>
  );
}

function sumPayout(bets: MarketView["bets"]): number {
  return bets.reduce((sum, b) => sum + (b.payout ?? 0), 0);
}

function Splash() {
  return (
    <div className="flex flex-1 items-center justify-center py-16">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
    </div>
  );
}
