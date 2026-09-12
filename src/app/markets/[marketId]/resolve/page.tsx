"use client";

/**
 * Resolution flow (see docs/resolver/PLAN-2-validate-settle.md):
 *
 *   1. World Selfie Check — live human vouches for the submission.
 *   2. A member photographs the outcome.
 *   3. The AI describes and validates it; a policy either locks in the outcome
 *      (`pending`) or hands it to the owner (`needs_owner`).
 *   4. Once close time passes the server settles on chain
 *      (`settling` → `settled`, or `failed` and retried).
 *
 * The screen is driven entirely by `market.resolution`. Until the market
 * resolves on chain non-owners get a redacted record — no photo, no verdict —
 * so a pending result can't be traded on.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { PhotoCapture } from "@/components/PhotoCapture";
import {
  WorldSelfieCheck,
  type WorldSelfieVerified,
} from "@/components/WorldSelfieCheck";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Countdown, useNow } from "@/components/Countdown";
import { useRequireUser } from "@/components/SessionProvider";
import { api, ApiError } from "@/lib/api";
import type {
  MarketView,
  ResolutionRecord,
  ResolutionStatus,
  SettleResult,
  Side,
} from "@/types";

type Busy = "submit" | "yes" | "no" | "settle" | "clear" | null;
type Flash = { tone: "ok" | "error"; text: string } | null;

/** How long to wait between `getMarket` polls while settlement is in flight. */
const POLL_MS = 3000;

export default function ResolveMarketPage() {
  const { marketId } = useParams<{ marketId: string }>();
  const { user, loading, refresh } = useRequireUser();
  const router = useRouter();
  const now = useNow();
  const [market, setMarket] = useState<MarketView | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [worldProof, setWorldProof] = useState<WorldSelfieVerified | null>(
    null,
  );
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash>(null);

  const load = useCallback(async () => {
    const { market } = await api.getMarket(marketId);
    setMarket(market);
  }, [marketId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (user) void load().catch(() => setError("Could not load market"));
  }, [user, load]);

  // Settlement runs server-side; poll until the record moves on. A `settled`
  // record on a market the indexer hasn't marked resolved yet is polled too.
  const resStatus = market?.resolution?.status;
  const polling =
    market !== null &&
    market.status !== "resolved" &&
    (resStatus === "settling" || resStatus === "settled");
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => void load().catch(() => {}), POLL_MS);
    return () => clearInterval(t);
  }, [polling, resStatus, load]);

  if (loading || !user || !market) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  /**
   * Run a mutation. On 409 the record changed under us (someone else
   * submitted, settlement started), so reload to show the current state.
   */
  async function run(
    kind: Exclude<Busy, null>,
    fn: () => Promise<{ market: MarketView; settle?: SettleResult | null }>,
    fallback: string,
  ) {
    setBusy(kind);
    setError(null);
    setFlash(null);
    try {
      const res = await fn();
      setMarket(res.market);
      if (res.settle) setFlash(describeSettle(res.settle));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
      if (e instanceof ApiError && e.status === 409) void load().catch(() => {});
      return false;
    } finally {
      setBusy(null);
    }
  }

  const isOwner = market.groupOwnerId === user.id;

  return (
    <div className="flex flex-1 flex-col">
      <TopBar title="Resolve" back />
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 no-scrollbar">
        <ResolveScreen
          market={market}
          marketId={marketId}
          userId={user.id}
          isOwner={isOwner}
          now={now}
          photo={photo}
          worldProof={worldProof}
          busy={busy}
          error={error}
          flash={flash}
          onCapture={setPhoto}
          onWorldVerified={setWorldProof}
          onWorldError={setError}
          onSubmit={async () => {
            if (!photo || !worldProof) return;
            const ok = await run(
              "submit",
              () =>
                api.resolveMarket(marketId, {
                  imageDataUrl: photo,
                  worldId: worldProof.worldId,
                }),
              "Analysis failed",
            );
            if (ok) {
              setPhoto(null);
              setWorldProof(null);
            }
          }}
          onConfirm={async (outcome) => {
            const ok = await run(
              outcome,
              () => api.confirmResolution(marketId, outcome),
              "Could not confirm",
            );
            if (ok) void refresh();
          }}
          onSettle={async () => {
            const ok = await run(
              "settle",
              () => api.settleMarket(marketId),
              "Could not settle",
            );
            if (ok) void refresh();
          }}
          onRetake={async () => {
            const ok = await run(
              "clear",
              () => api.clearResolution(marketId),
              "Could not clear the photo",
            );
            if (ok) {
              setPhoto(null);
              setWorldProof(null);
            }
          }}
          onDone={() => router.replace(`/markets/${marketId}`)}
        />
      </div>
    </div>
  );
}

/** Picks the view for the market's resolution state. Pure: props in, UI out. */
function ResolveScreen({
  market,
  marketId,
  userId,
  isOwner,
  now,
  photo,
  worldProof,
  busy,
  error,
  flash,
  onCapture,
  onWorldVerified,
  onWorldError,
  onSubmit,
  onConfirm,
  onSettle,
  onRetake,
  onDone,
}: {
  market: MarketView;
  marketId: string;
  userId: string;
  isOwner: boolean;
  now: number;
  photo: string | null;
  worldProof: WorldSelfieVerified | null;
  busy: Busy;
  error: string | null;
  flash: Flash;
  onCapture: (dataUrl: string) => void;
  onWorldVerified: (result: WorldSelfieVerified) => void;
  onWorldError: (message: string) => void;
  onSubmit: () => void;
  onConfirm: (outcome: Side) => void;
  onSettle: () => void;
  onRetake: () => void;
  onDone: () => void;
}) {
  const res = market.resolution;
  const messages = (
    <>
      {flash && (
        <p className={`text-sm ${flash.tone === "ok" ? "text-yes" : "text-no"}`}>
          {flash.text}
        </p>
      )}
      {error && <p className="text-sm text-no">{error}</p>}
    </>
  );

  if (market.status === "resolved") {
    return (
      <>
        <SettledView market={market} />
        {messages}
        <div className="mt-auto">
          <Button onClick={onDone}>See results</Button>
        </div>
      </>
    );
  }

  if (!res) {
    return (
      <>
        <p className="text-sm text-muted">
          Verify with World, then photograph the outcome. AI reads it and, if
          it&apos;s clear, locks in the result — otherwise the owner decides.
          Trading pauses once a photo is submitted.
        </p>
        <WorldSelfieCheck
          action="resolve"
          marketId={marketId}
          signal={`${userId}:${marketId}`}
          label="Selfie Check to submit"
          onVerified={onWorldVerified}
          onError={onWorldError}
        />
        <PhotoCapture
          facingMode="environment"
          captureLabel="Take photo"
          onCapture={onCapture}
        />
        {messages}
        <div className="mt-auto">
          <Button
            loading={busy === "submit"}
            disabled={!photo || !worldProof}
            onClick={onSubmit}
          >
            {busy === "submit" ? "Analyzing…" : "Submit photo"}
          </Button>
        </div>
      </>
    );
  }

  if (res.status === "settling" || res.status === "settled") {
    return (
      <>
        <Card className="flex items-center gap-3">
          <Spinner />
          <div>
            <p className="font-display text-lg font-bold tracking-wide">
              {res.status === "settling"
                ? "Settling on chain…"
                : "Settled — updating…"}
            </p>
            <p className="text-xs text-muted">
              This takes a few seconds on devnet. The page updates by itself.
            </p>
          </div>
        </Card>
        {!res.redacted && isOwner && res.outcome && (
          <p className="text-sm text-muted">
            Writing <OutcomeText outcome={res.outcome} /> (
            {res.source === "owner" ? "your call" : "AI"}).
          </p>
        )}
        {messages}
      </>
    );
  }

  // Non-owners never see the photo or verdict before resolution. The owner
  // check is belt-and-braces: the server should already have redacted it.
  if (res.redacted || !isOwner) {
    return (
      <>
        <Card className="space-y-2">
          <p className="label-hud">Resolution photo submitted</p>
          <p className="font-display text-lg font-bold tracking-wide">
            {MEMBER_STATUS_COPY[res.status]}
          </p>
          <p className="text-xs text-muted">
            Submitted {formatTime(res.submittedAt)}. Trading is paused while the
            result is decided. The photo and AI reading are shown once the
            market resolves.
          </p>
        </Card>
        {messages}
      </>
    );
  }

  const photoEl = market.resolutionImageUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={market.resolutionImageUrl}
      alt="Resolution photo"
      className="w-full rounded-xl object-cover"
    />
  ) : null;
  const closed = now >= market.expiresAt;
  const retake = (
    <Button
      variant="ghost"
      loading={busy === "clear"}
      disabled={busy !== null}
      onClick={onRetake}
    >
      Retake photo
    </Button>
  );

  if (res.status === "needs_owner") {
    return (
      <>
        {photoEl}
        {res.stub && <StubNotice />}
        <Card className="space-y-1">
          <p className="label-hud">Needs your call</p>
          <p className="text-sm">{res.policyReason}</p>
        </Card>
        <VerdictCard record={res} />
        {messages}
        <p className="text-center text-xs text-muted">
          {closed
            ? "Close time has passed — your pick settles on chain right away."
            : "Your pick is locked in and settles when the event closes."}
        </p>
        <div className="mt-auto grid grid-cols-2 gap-3">
          <Button
            variant="yes"
            loading={busy === "yes"}
            disabled={busy !== null}
            onClick={() => onConfirm("yes")}
          >
            Yes
          </Button>
          <Button
            variant="no"
            loading={busy === "no"}
            disabled={busy !== null}
            onClick={() => onConfirm("no")}
          >
            No
          </Button>
        </div>
        {retake}
      </>
    );
  }

  // Owner, `pending` or `failed`: the outcome is chosen, settlement is next.
  const failed = res.status === "failed";
  return (
    <>
      {photoEl}
      {failed && (
        <Card className="space-y-1 border-no/40 bg-no/10">
          <p className="label-hud text-no">Settlement failed</p>
          <p className="text-sm">{res.error ?? "Unknown error"}</p>
          <p className="text-xs text-muted">
            {res.attempts} attempt{res.attempts === 1 ? "" : "s"} so far. It
            retries automatically, or retry now.
          </p>
        </Card>
      )}
      <Card className="space-y-2">
        <p className="label-hud">Locked in</p>
        <div className="flex items-center justify-between">
          {res.outcome ? (
            <OutcomeText
              outcome={res.outcome}
              className="font-display text-2xl font-extrabold tracking-wide"
            />
          ) : (
            <span className="text-muted">—</span>
          )}
          <span className="text-xs text-muted">
            {res.source === "owner" ? "Chosen by you" : "Chosen by AI"}
          </span>
        </div>
        {!failed && (
          <p className="text-sm text-muted">
            {closed ? (
              "Close time has passed — settling shortly."
            ) : (
              <>
                Settles automatically in{" "}
                <Countdown
                  expiresAt={market.expiresAt}
                  className="font-semibold tabular-nums text-foreground"
                />
              </>
            )}
          </p>
        )}
      </Card>
      {res.stub && <StubNotice />}
      <VerdictCard record={res} />
      {messages}
      <div className="mt-auto space-y-2">
        <Button
          variant={failed ? "primary" : "secondary"}
          loading={busy === "settle"}
          disabled={busy !== null || !closed}
          onClick={onSettle}
        >
          {failed ? "Retry settlement" : "Settle now"}
        </Button>
        {!closed && (
          <p className="text-center text-xs text-muted">
            Settle now unlocks once the event closes.
          </p>
        )}
      </div>
      {retake}
    </>
  );
}

const MEMBER_STATUS_COPY: Record<ResolutionStatus, string> = {
  pending: "Settles automatically when the event closes",
  needs_owner: "Waiting for the owner to decide",
  settling: "Settling on chain…",
  failed: "Settlement is retrying",
  settled: "Settled on chain",
};

/** The AI's reading: verdict + confidence bar, reasoning, evidence, red flags. */
function VerdictCard({ record }: { record: ResolutionRecord }) {
  const confidence = Math.round(record.confidence * 100);
  const decided = record.verdict !== "neither";
  const tone =
    record.verdict === "yes" ? "yes" : record.verdict === "no" ? "no" : null;
  return (
    <Card className="space-y-3">
      <p className="label-hud">AI reading</p>
      <div className="flex items-center justify-between">
        <span
          className={[
            "font-display text-2xl font-extrabold tracking-wide",
            tone === "yes" ? "text-yes" : tone === "no" ? "text-no" : "text-muted",
          ].join(" ")}
        >
          {decided ? record.verdict.toUpperCase() : "Couldn't decide"}
        </span>
        <span className="font-display text-sm font-bold tabular-nums text-muted">
          {confidence}% confidence
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2">
        <div
          className={
            tone === "yes" ? "h-full bg-yes" : tone === "no" ? "h-full bg-no" : "h-full bg-muted"
          }
          style={{ width: `${confidence}%` }}
        />
      </div>
      {record.reasoning && <p className="text-sm text-muted">{record.reasoning}</p>}
      {record.evidence.length > 0 && (
        <div>
          <p className="label-hud mb-1">Evidence</p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted">
            {record.evidence.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {record.redFlags.length > 0 && (
        <div>
          <p className="label-hud mb-1 text-no">Red flags</p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-no">
            {record.redFlags.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function StubNotice() {
  return (
    <Card className="border-brand/40 bg-brand/10 text-sm">
      The AI resolver isn&apos;t configured on this server, so this reading is a
      placeholder. Decide from the photo.
    </Card>
  );
}

function SettledView({ market }: { market: MarketView }) {
  const res = market.resolution;
  const visible = res && !res.redacted ? res : null;
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
        {visible ? (
          <>
            <p className="text-sm text-muted">
              {visible.source === "owner" ? "Decided by the owner" : "Decided by AI"}
              {visible.verdict !== "neither"
                ? ` · AI read ${visible.verdict.toUpperCase()} (${Math.round(visible.confidence * 100)}%)`
                : " · AI couldn't decide"}
            </p>
            {visible.reasoning && (
              <p className="text-sm text-muted">“{visible.reasoning}”</p>
            )}
          </>
        ) : (
          market.aiPrediction && (
            <p className="text-sm text-muted">
              AI suggested {market.aiPrediction.toUpperCase()} (
              {Math.round((market.aiConfidence ?? 0) * 100)}%)
            </p>
          )
        )}
      </Card>
    </>
  );
}

function OutcomeText({ outcome, className = "" }: { outcome: Side; className?: string }) {
  return (
    <span className={`${outcome === "yes" ? "text-yes" : "text-no"} ${className}`}>
      {outcome.toUpperCase()}
    </span>
  );
}

function Spinner() {
  return (
    <span className="h-6 w-6 shrink-0 animate-spin rounded-full border-2 border-brand border-t-transparent" />
  );
}

/** Inline copy for a settle attempt returned by a mutation. */
function describeSettle(settle: SettleResult): Flash {
  switch (settle.state) {
    case "settled":
      return { tone: "ok", text: `Resolved ${settle.outcome.toUpperCase()} on chain.` };
    case "waiting":
      return {
        tone: "ok",
        text: `Locked in — settles at close (${formatTime(settle.closesAt)}).`,
      };
    case "skipped":
      return { tone: "ok", text: settle.reason };
    case "failed":
      return { tone: "error", text: `Settlement failed: ${settle.error}` };
  }
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
