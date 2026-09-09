"use client";

/**
 * Owner resolution flow:
 *   1. Take a photo
 *   2. AI predicts yes/no + confidence (advisory only)
 *   3. Owner confirms the outcome (the human vote — later a 3/4 majority)
 */

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { PhotoCapture } from "@/components/PhotoCapture";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useRequireUser } from "@/components/SessionProvider";
import { api } from "@/lib/api";
import type { MarketView, Side } from "@/types";

export default function ResolveMarketPage() {
  const { marketId } = useParams<{ marketId: string }>();
  const { user, loading, refresh } = useRequireUser();
  const router = useRouter();
  const [market, setMarket] = useState<MarketView | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [confirming, setConfirming] = useState<Side | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { market } = await api.getMarket(marketId);
    setMarket(market);
    if (market.resolutionImageUrl) setPhoto(market.resolutionImageUrl);
  }, [marketId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (user) void load().catch(() => setError("Could not load market"));
  }, [user, load]);

  if (loading || !user || !market) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  const isOwner = market.groupOwnerId === user.id;
  const hasPrediction = Boolean(market.aiPrediction && market.resolutionImageUrl);
  const settled = market.status === "resolved";

  async function analyze() {
    if (!photo) return;
    setAnalyzing(true);
    setError(null);
    try {
      const res = await api.resolveMarket(marketId, { imageDataUrl: photo });
      setMarket(res.market);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  }

  async function confirm(outcome: Side) {
    setConfirming(outcome);
    setError(null);
    try {
      const res = await api.confirmResolution(marketId, outcome);
      setMarket(res.market);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not confirm");
    } finally {
      setConfirming(null);
    }
  }

  if (!isOwner) {
    return (
      <div className="flex flex-1 flex-col">
        <TopBar title="Resolve" back />
        <div className="flex flex-1 flex-col justify-center gap-3 p-6">
          <p className="font-display text-2xl font-extrabold uppercase">
            Owner only
          </p>
          <p className="text-sm text-muted">
            Only the group owner can resolve this event.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <TopBar title="Resolve" back />
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 no-scrollbar">
        {settled ? (
          <SettledView market={market} onDone={() => router.replace(`/markets/${marketId}`)} />
        ) : hasPrediction ? (
          <VoteView
            market={market}
            photo={photo ?? market.resolutionImageUrl!}
            confirming={confirming}
            error={error}
            onConfirm={confirm}
            onRetake={() => {
              setPhoto(null);
              setMarket({
                ...market,
                aiPrediction: undefined,
                aiConfidence: undefined,
                resolutionImageUrl: undefined,
              });
            }}
          />
        ) : (
          <>
            <p className="text-sm text-muted">
              Take a photo of the outcome. AI will suggest yes or no — you
              confirm the result.
            </p>
            <PhotoCapture
              facingMode="environment"
              captureLabel="Take photo"
              onCapture={setPhoto}
            />
            {error && <p className="text-sm text-no">{error}</p>}
            <div className="mt-auto">
              <Button
                loading={analyzing}
                disabled={!photo}
                onClick={analyze}
              >
                {analyzing ? "Analyzing…" : "Analyze photo"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function VoteView({
  market,
  photo,
  confirming,
  error,
  onConfirm,
  onRetake,
}: {
  market: MarketView;
  photo: string;
  confirming: Side | null;
  error: string | null;
  onConfirm: (outcome: Side) => void;
  onRetake: () => void;
}) {
  const predicted = market.aiPrediction;
  const confidence = Math.round((market.aiConfidence ?? 0) * 100);
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photo}
        alt="Resolution photo"
        className="w-full rounded-xl object-cover"
      />
      <Card className="space-y-3">
        <p className="label-hud">AI prediction</p>
        <div className="flex items-center justify-between">
          <span
            className={[
              "font-display text-2xl font-extrabold tracking-wide",
              predicted === "yes" ? "text-yes" : "text-no",
            ].join(" ")}
          >
            {predicted?.toUpperCase()}
          </span>
          <span className="font-display text-sm font-bold tabular-nums text-muted">
            {confidence}% confidence
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-surface-2">
          <div
            className={predicted === "yes" ? "h-full bg-yes" : "h-full bg-no"}
            style={{ width: `${confidence}%` }}
          />
        </div>
        {market.resolutionNote && (
          <p className="text-sm text-muted">“{market.resolutionNote}”</p>
        )}
        <p className="text-xs text-muted">
          Advisory only. You decide the official result.
        </p>
      </Card>
      {error && <p className="text-sm text-no">{error}</p>}
      <div className="mt-auto grid grid-cols-2 gap-3">
        <Button
          variant="yes"
          loading={confirming === "yes"}
          disabled={confirming !== null}
          onClick={() => onConfirm("yes")}
        >
          Yes
        </Button>
        <Button
          variant="no"
          loading={confirming === "no"}
          disabled={confirming !== null}
          onClick={() => onConfirm("no")}
        >
          No
        </Button>
      </div>
      <Button variant="ghost" disabled={confirming !== null} onClick={onRetake}>
        Retake photo
      </Button>
    </>
  );
}

function SettledView({
  market,
  onDone,
}: {
  market: MarketView;
  onDone: () => void;
}) {
  return (
    <>
      {market.resolutionImageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={market.resolutionImageUrl}
          alt="Resolution photo"
          className="w-full rounded-xl object-cover"
        />
      )}
      <Card className="space-y-2">
        <p className="label-hud">Official result</p>
        <p
          className={[
            "font-display text-2xl font-extrabold",
            market.outcome === "yes" ? "text-yes" : "text-no",
          ].join(" ")}
        >
          {market.outcome?.toUpperCase()}
        </p>
        {market.aiPrediction && (
          <p className="text-sm text-muted">
            AI suggested {market.aiPrediction.toUpperCase()} (
            {Math.round((market.aiConfidence ?? 0) * 100)}%)
          </p>
        )}
      </Card>
      <div className="mt-auto">
        <Button onClick={onDone}>See results</Button>
      </div>
    </>
  );
}
