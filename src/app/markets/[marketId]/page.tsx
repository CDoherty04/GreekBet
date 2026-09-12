"use client";

/**
 * Market detail — LMSR odds, buy/sell shares, redeem after resolution.
 *
 * The trading panel differs from the old parimutuel one in two ways that
 * matter to the user, not just the code:
 *
 * * **You can sell before resolution.** A position is shares in a market maker,
 *   not a stake in a pot, so it can be closed at the prevailing price.
 * * **The quote is live and authoritative.** Before trading, the amount is
 *   simulated against the real program, so the shares shown are the shares the
 *   chain will actually mint — not a JavaScript estimate of the curve.
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
import { usePrivySend } from "@/hooks/usePrivySend";
import { api, ApiError } from "@/lib/api";
import { formatProb, winningShares } from "@/lib/market-display";
import { formatUnits, parseUnits, UNIT } from "@/lib/chain/config";
import type { MarketView, ResolutionStatus, Side } from "@/types";

type Action = "buy" | "sell";

export default function MarketDetailPage() {
  const { marketId } = useParams<{ marketId: string }>();
  const { user, loading } = useRequireUser();
  const { sendBase64 } = usePrivySend();
  const [market, setMarket] = useState<MarketView | null>(null);
  const [side, setSide] = useState<Side>("yes");
  const [action, setAction] = useState<Action>("buy");
  const [amount, setAmount] = useState("1");
  const [quote, setQuote] = useState<{ received: string; avgPrice: string } | null>(
    null,
  );
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const now = useNow();

  const load = useCallback(async () => {
    const { market } = await api.getMarket(marketId);
    setMarket(market);
  }, [marketId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (user) void load().catch(() => setError("Could not load market"));
  }, [user, load]);

  // A market is created on chain before the indexer sees it. Poll briefly
  // rather than leaving the screen stuck on "confirming".
  useEffect(() => {
    if (!market || market.indexed) return;
    const t = setInterval(() => void load().catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [market, load]);

  // A submitted resolution photo pauses app trading until the market resolves
  // (the trade route refuses with 409), so don't quote either.
  const tradingPaused =
    market?.resolution !== undefined && market.status !== "resolved";

  // Quote whenever the trade changes. Debounced: each quote is a simulated
  // transaction against devnet, so firing one per keystroke would be slow and
  // would draw rate limiting.
  useEffect(() => {
    if (!market?.indexed || market.status !== "open" || tradingPaused) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      let base: bigint;
      try {
        base = parseUnits(amount);
      } catch {
        setQuote(null);
        return;
      }
      if (base <= 0n) {
        setQuote(null);
        return;
      }
      setQuoting(true);
      try {
        const q = await api.quote(marketId, {
          side,
          action,
          amount: base.toString(),
        });
        if (!cancelled) setQuote(q);
      } catch {
        // A quote can legitimately fail — selling more than you hold, a trade
        // that prices to zero. The trade button surfaces the real reason.
        if (!cancelled) setQuote(null);
      } finally {
        if (!cancelled) setQuoting(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [amount, side, action, marketId, market?.indexed, market?.status, tradingPaused]);

  async function submitTrade() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const base = parseUnits(amount);
      const prepared = await api.prepareTrade(marketId, {
        side,
        action,
        amount: base.toString(),
      });
      const signature = await sendBase64(prepared.transaction);
      setNotice(
        action === "buy"
          ? `Bought ${formatUnits(prepared.received)} ${side.toUpperCase()} shares`
          : `Sold for $${formatUnits(prepared.received)}`,
      );
      void signature;
      setTimeout(() => void load().catch(() => {}), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Trade failed");
      // 409 = a resolution photo landed since this page loaded and trading is
      // paused. Reload so the notice replaces the live trade panel.
      if (e instanceof ApiError && e.status === 409) {
        void load().catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitRedeem() {
    setBusy(true);
    setError(null);
    try {
      const prepared = await api.prepareRedeem(marketId);
      await sendBase64(prepared.transaction);
      setNotice("Redeemed");
      setTimeout(() => void load().catch(() => {}), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not redeem");
    } finally {
      setBusy(false);
    }
  }

  if (loading || !user || !market) return <Splash />;

  if (!market.indexed) {
    return (
      <div className="flex flex-1 flex-col">
        <TopBar back centerTitle right={<BalancePill />} />
        <div className="flex-1 space-y-4 p-4">
          <h1 className="font-display text-2xl font-extrabold uppercase leading-tight tracking-wide">
            {market.title}
          </h1>
          <Card>
            <p className="text-sm text-muted">
              Confirming on chain. This takes a few seconds on devnet.
            </p>
          </Card>
        </div>
      </div>
    );
  }

  const live = market.status === "open" && market.expiresAt > now;
  // The group owner referees: they confirm the result, so they do not trade.
  // Keeping the referee out of the book is the whole reason that split exists.
  const isOwner = market.groupOwnerId === user.id;
  const pos = market.myPosition;
  const held = pos
    ? side === "yes"
      ? pos.yesShares
      : pos.noShares
    : "0";
  const myWinnings = winningShares(market);

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
          <OddsBar pricing={market.pricing} />
          <div className="mt-3 flex justify-between text-xs text-muted">
            <span>${formatUnits(market.pricing.volume)} in the vault</span>
            <span>
              {market.trades.length} trade
              {market.trades.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="mt-2 text-[11px] text-muted">
            Priced by an LMSR market maker · liquidity $
            {formatUnits(market.pricing.b, 0)}
          </p>
        </Card>

        {pos && (Number(pos.yesShares) > 0 || Number(pos.noShares) > 0) && (
          <Card className="space-y-1">
            <p className="label-hud">Your position</p>
            <div className="flex gap-4 text-sm">
              <span className="text-yes">
                {formatUnits(pos.yesShares)} YES
              </span>
              <span className="text-no">{formatUnits(pos.noShares)} NO</span>
            </div>
          </Card>
        )}

        {tradingPaused && <ResolutionNotice market={market} isOwner={isOwner} />}

        {market.status === "resolved" ? (
          <ResolvedPanel
            market={market}
            winning={myWinnings}
            busy={busy}
            onRedeem={submitRedeem}
          />
        ) : isOwner && live ? (
          <Card className="text-sm text-muted">
            You&apos;re the group owner, you referee this event and can&apos;t
            trade in it.
          </Card>
        ) : live ? (
          <TradePanel
            side={side}
            setSide={setSide}
            action={action}
            setAction={setAction}
            amount={amount}
            setAmount={setAmount}
            quote={quote}
            quoting={quoting}
            busy={busy}
            held={held}
            yesProb={market.pricing.yesProb}
            paused={tradingPaused}
            onSubmit={submitTrade}
          />
        ) : tradingPaused ? null : (
          <Card>
            <p className="text-sm text-muted">
              Trading is closed. Waiting on resolution.
            </p>
          </Card>
        )}

        {notice && <p className="text-sm text-yes">{notice}</p>}
        {error && <p className="text-sm text-no">{error}</p>}

        {market.trades.length > 0 && (
          <div>
            <p className="label-hud mb-2">Trades</p>
            <div className="space-y-2">
              {market.trades
                .slice()
                .reverse()
                .map((t) => (
                  <div
                    key={`${t.signature}-${t.slot}-${t.user}`}
                    className="flex items-center justify-between rounded-xl border border-border bg-surface px-3 py-2 text-sm"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <TradeAvatar
                        name={t.userName ?? shorten(t.user)}
                        avatarUrl={t.userAvatarUrl}
                      />
                      <span className="truncate">
                        {t.userName ?? shorten(t.user)}
                        {t.user === user.walletAddress ? " · you" : ""}
                      </span>
                    </div>
                    <div className="ml-3 flex shrink-0 items-center gap-2">
                      <span className="text-muted">
                        {t.isBuy ? "bought" : "sold"}
                      </span>
                      <span className={t.side === "yes" ? "text-yes" : "text-no"}>
                        {formatUnits(t.shares)} {t.side.toUpperCase()}
                      </span>
                      <span className="text-muted">
                        ${formatUnits(t.collateral)}
                      </span>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>

      {market.status !== "resolved" && (
        <div className="border-t border-border p-4">
          <Link href={`/markets/${market.address}/resolve`}>
            <Button variant={live && !tradingPaused ? "secondary" : "primary"}>
              {resolveLinkLabel(market, isOwner)}
            </Button>
          </Link>
        </div>
      )}
    </div>
  );
}

function resolveLinkLabel(market: MarketView, isOwner: boolean): string {
  const status = market.resolution?.status;
  if (!status) return "Resolve with photo";
  if (!isOwner) return "View resolution status";
  if (status === "needs_owner") return "Decide the result";
  if (status === "failed") return "Retry settlement";
  return "Review resolution";
}

function shorten(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

function TradePanel({
  side,
  setSide,
  action,
  setAction,
  amount,
  setAmount,
  quote,
  quoting,
  busy,
  held,
  yesProb,
  paused,
  onSubmit,
}: {
  side: Side;
  setSide: (s: Side) => void;
  action: Action;
  setAction: (a: Action) => void;
  amount: string;
  setAmount: (v: string) => void;
  quote: { received: string; avgPrice: string } | null;
  quoting: boolean;
  busy: boolean;
  held: string;
  yesProb: number;
  /** A resolution photo is in: everything renders but nothing is usable. */
  paused: boolean;
  onSubmit: () => void;
}) {
  let parsed: bigint | null = null;
  let parseError: string | null = null;
  try {
    parsed = parseUnits(amount);
    if (parsed <= 0n) parseError = "Enter an amount";
  } catch (e) {
    parseError = e instanceof Error ? e.message : "Invalid amount";
  }

  // Selling more than you hold is the one error worth catching before the
  // round trip — the chain would reject it, but only after a slow trip.
  const overSell =
    action === "sell" && parsed !== null && parsed > BigInt(held || "0");

  return (
    <Card className={`space-y-4 ${paused ? "opacity-60" : ""}`}>
      <fieldset disabled={paused} className="min-w-0 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => setSide("yes")}
          className={[
            "rounded-2xl border-2 py-4 text-center transition",
            side === "yes" ? "border-yes bg-yes/15" : "border-border bg-surface-2",
          ].join(" ")}
        >
          <div className="font-display text-lg font-bold tracking-wide text-yes">
            YES
          </div>
          <div className="text-xs text-muted">{formatProb(yesProb)}</div>
        </button>
        <button
          onClick={() => setSide("no")}
          className={[
            "rounded-2xl border-2 py-4 text-center transition",
            side === "no" ? "border-no bg-no/15" : "border-border bg-surface-2",
          ].join(" ")}
        >
          <div className="font-display text-lg font-bold tracking-wide text-no">
            NO
          </div>
          <div className="text-xs text-muted">{formatProb(1 - yesProb)}</div>
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {(["buy", "sell"] as const).map((a) => (
          <button
            key={a}
            onClick={() => setAction(a)}
            className={[
              "rounded-xl border py-2 text-sm font-semibold uppercase tracking-wide transition",
              action === a
                ? "border-brand bg-brand/15 text-brand"
                : "border-border bg-surface-2 text-muted",
            ].join(" ")}
          >
            {a}
          </button>
        ))}
      </div>

      <label className="block">
        <span className="mb-1.5 block label-hud">
          {action === "buy" ? "Spend (USDC)" : "Sell (shares)"}
        </span>
        <input
          type="text"
          inputMode="decimal"
          name="amount"
          placeholder="1.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
          className={[
            "w-full rounded-2xl border bg-surface-2 px-4 py-3.5 text-base text-foreground outline-none",
            parseError || overSell ? "border-no" : "border-border focus:border-brand",
          ].join(" ")}
        />
        <span
          className={`mt-1.5 block text-xs ${
            parseError || overSell ? "text-no" : "text-muted"
          }`}
        >
          {overSell
            ? `You hold ${formatUnits(held)} ${side.toUpperCase()}`
            : (parseError ??
              (action === "sell"
                ? `${formatUnits(held)} ${side.toUpperCase()} available`
                : "Priced by the market maker"))}
        </span>
      </label>

      <div className="rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm">
        {paused ? (
          <span className="text-muted">Trading paused</span>
        ) : quoting ? (
          <span className="text-muted">Quoting…</span>
        ) : quote ? (
          <div className="flex items-center justify-between">
            <span className="text-muted">
              {action === "buy" ? "You receive" : "You get"}
            </span>
            <span className="font-semibold">
              {action === "buy"
                ? `${formatUnits(quote.received)} ${side.toUpperCase()}`
                : `$${formatUnits(quote.received)}`}
              <span className="ml-2 text-xs font-normal text-muted">
                @ {Math.round((Number(quote.avgPrice) / UNIT) * 100)}¢
              </span>
            </span>
          </div>
        ) : (
          <span className="text-muted">Enter an amount for a quote</span>
        )}
      </div>

      <Button
        variant={side === "yes" ? "yes" : "no"}
        loading={busy}
        disabled={paused || parsed === null || parseError !== null || overSell}
        onClick={onSubmit}
      >
        {paused
          ? "Trading paused"
          : `${action === "buy" ? "Buy" : "Sell"} ${side.toUpperCase()}`}
      </Button>
      </fieldset>
    </Card>
  );
}

function ResolvedPanel({
  market,
  winning,
  busy,
  onRedeem,
}: {
  market: MarketView;
  winning: string;
  busy: boolean;
  onRedeem: () => void;
}) {
  const won = market.outcome === "yes";
  const redeemed = market.myPosition?.redeemed ?? false;
  const canRedeem =
    !redeemed &&
    market.myPosition !== undefined &&
    (Number(market.myPosition.yesShares) > 0 ||
      Number(market.myPosition.noShares) > 0);

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
        {Number(winning) > 0 && (
          <span className="text-sm font-semibold text-yes">
            {formatUnits(winning)} winning shares
          </span>
        )}
      </div>

      {market.resolution && !market.resolution.redacted ? (
        <p className="text-sm text-muted">
          <span className="font-medium text-foreground">
            {market.resolution.source === "owner"
              ? "Decided by the owner."
              : "Decided by AI."}
          </span>{" "}
          {market.resolution.reasoning}
        </p>
      ) : (
        market.resolutionNote && (
          <p className="text-sm text-muted">
            <span className="font-medium text-foreground">AI resolver:</span>{" "}
            {market.resolutionNote}
          </p>
        )
      )}

      {redeemed && market.myPosition?.payout !== undefined && (
        <p className="text-sm text-yes">
          Redeemed ${formatUnits(market.myPosition.payout)}
        </p>
      )}

      {canRedeem && (
        <Button loading={busy} onClick={onRedeem}>
          {Number(winning) > 0
            ? `Redeem $${formatUnits(winning)}`
            : "Close out position"}
        </Button>
      )}
    </Card>
  );
}

const RESOLUTION_STATUS_COPY: Record<ResolutionStatus, string> = {
  pending: "Settles automatically when the event closes",
  needs_owner: "Waiting for the owner to decide",
  settling: "Settling on chain…",
  failed: "Settlement is retrying",
  settled: "Settled on chain",
};

/**
 * A resolution photo is in but the market hasn't resolved on chain.
 *
 * Members see only that and the status: the photo and verdict reveal the
 * answer, so they stay hidden until resolution (the server redacts them). The
 * owner gets a pointer to the resolve screen, where the details live.
 */
function ResolutionNotice({
  market,
  isOwner,
}: {
  market: MarketView;
  isOwner: boolean;
}) {
  const res = market.resolution;
  if (!res) return null;
  const ownerView = isOwner && !res.redacted;
  return (
    <Card className="space-y-1 border-brand/40">
      <p className="label-hud text-brand">Resolution submitted — trading paused</p>
      <p className="text-sm">
        {ownerView && res.status === "needs_owner"
          ? "The AI couldn't settle this on its own. Your call."
          : ownerView && res.status === "pending" && res.outcome
            ? `Locked in ${res.outcome.toUpperCase()} (${
                res.source === "owner" ? "your call" : "AI"
              }) — settles when the event closes.`
            : RESOLUTION_STATUS_COPY[res.status]}
      </p>
    </Card>
  );
}

function TradeAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
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

function Splash() {
  return (
    <div className="flex flex-1 items-center justify-center py-16">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
    </div>
  );
}
