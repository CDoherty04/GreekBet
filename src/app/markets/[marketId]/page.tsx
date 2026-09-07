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
import { useRequireUser } from "@/components/SessionProvider";
import { api } from "@/lib/api";
import { formatProb } from "@/lib/markets";
import type { MarketView, Side } from "@/types";

const CHIPS = [10, 25, 50, 100];

export default function MarketDetailPage() {
  const { marketId } = useParams<{ marketId: string }>();
  const { user, loading, setUser } = useRequireUser();
  const [market, setMarket] = useState<MarketView | null>(null);
  const [side, setSide] = useState<Side>("yes");
  const [amount, setAmount] = useState(25);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const res = await api.placeBet(marketId, { side, amount });
      setMarket(res.market);
      if (user) setUser({ ...user, balance: res.balance });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not place bet");
    } finally {
      setPlacing(false);
    }
  }

  if (loading || !user || !market) return <Splash />;

  // Expiry is enforced server-side on bet; here we key the UI off status.
  const isOpen = market.status === "open";
  const myBets = market.bets.filter((b) => b.userId === user.id);

  return (
    <div className="flex flex-1 flex-col">
      <TopBar back right={<BalancePill />} />
      <div className="flex-1 space-y-4 overflow-y-auto p-4 no-scrollbar">
        <div>
          <h1 className="text-xl font-bold leading-snug">{market.title}</h1>
          {market.description && (
            <p className="mt-1 text-sm text-muted">{market.description}</p>
          )}
        </div>

        <Card>
          <OddsBar pool={market.pool} />
          <div className="mt-3 flex justify-between text-xs text-muted">
            <span>🪙 {market.pool.total.toLocaleString()} pool</span>
            <span>{market.bets.length} bets</span>
          </div>
        </Card>

        {market.status === "resolved" ? (
          <ResolvedPanel market={market} myPayout={sumPayout(myBets)} />
        ) : isOpen ? (
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
        ) : (
          <Card className="text-center text-sm text-muted">
            Betting has closed. Waiting for resolution.
          </Card>
        )}

        {error && <p className="text-sm text-no">{error}</p>}

        {myBets.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
              Your bets
            </p>
            <div className="space-y-2">
              {myBets.map((b) => (
                <div
                  key={b.id}
                  className="flex items-center justify-between rounded-xl border border-border bg-surface px-3 py-2 text-sm"
                >
                  <span
                    className={b.side === "yes" ? "text-yes" : "text-no"}
                  >
                    {b.side.toUpperCase()} · 🪙 {b.amount}
                  </span>
                  {b.payout !== undefined && (
                    <span className={b.payout > 0 ? "text-yes" : "text-muted"}>
                      {b.payout > 0 ? `+${b.payout}` : "—"}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {market.status !== "resolved" && (
        <div className="border-t border-border p-4">
          <Link href={`/markets/${marketId}/resolve`}>
            <Button variant="secondary">📸 Resolve with photo</Button>
          </Link>
        </div>
      )}
    </div>
  );
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
  amount: number;
  setAmount: (n: number) => void;
  balance: number;
  placing: boolean;
  onPlace: () => void;
  yesProb: number;
}) {
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
          <div className="text-lg font-bold text-yes">YES</div>
          <div className="text-xs text-muted">{formatProb(yesProb)}</div>
        </button>
        <button
          onClick={() => setSide("no")}
          className={[
            "rounded-2xl border-2 py-4 text-center transition",
            side === "no" ? "border-no bg-no/15" : "border-border bg-surface-2",
          ].join(" ")}
        >
          <div className="text-lg font-bold text-no">NO</div>
          <div className="text-xs text-muted">{formatProb(1 - yesProb)}</div>
        </button>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {CHIPS.map((c) => (
          <button
            key={c}
            onClick={() => setAmount(c)}
            disabled={c > balance}
            className={[
              "rounded-xl border py-2.5 text-sm font-semibold transition disabled:opacity-40",
              amount === c
                ? "border-brand bg-brand/15"
                : "border-border bg-surface-2 text-muted",
            ].join(" ")}
          >
            {c}
          </button>
        ))}
      </div>

      <Button
        variant={side === "yes" ? "yes" : "no"}
        loading={placing}
        disabled={amount <= 0 || amount > balance}
        onClick={onPlace}
      >
        Bet 🪙 {amount} on {side.toUpperCase()}
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
          <span className="font-medium text-foreground">AI resolver:</span>{" "}
          {market.resolutionNote}
        </p>
      )}
    </Card>
  );
}

function sumPayout(bets: MarketView["bets"]): number {
  return bets.reduce((sum, b) => sum + (b.payout ?? 0), 0);
}

function Splash() {
  return (
    <div className="flex flex-1 items-center justify-center py-16">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-transparent" />
    </div>
  );
}
