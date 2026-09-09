"use client";

/**
 * Resolve a market from a photo — the moment that chains every sponsor:
 *   snap a photo → World face-match → AI resolver decides → tokens pay out.
 */

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { PhotoCapture } from "@/components/PhotoCapture";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useRequireUser } from "@/components/SessionProvider";
import { api } from "@/lib/api";
import type { Side } from "@/types";

interface Result {
  outcome: Side;
  description: string;
  faceMatch: { match: boolean; confidence: number };
}

export default function ResolveMarketPage() {
  const { marketId } = useParams<{ marketId: string }>();
  const { user, refresh } = useRequireUser();
  const router = useRouter();
  const [photo, setPhoto] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve() {
    if (!photo) return;
    setRunning(true);
    setError(null);
    try {
      const res = await api.resolveMarket(marketId, { imageDataUrl: photo });
      setResult({
        outcome: res.outcome,
        description: res.description,
        faceMatch: res.faceMatch,
      });
      // Winnings may have been credited — refresh the balance.
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resolution failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <TopBar title="Resolve market" back />
      <div className="flex flex-1 flex-col gap-4 p-4">
        {!result ? (
          <>
            <p className="text-sm text-muted">
              Take a photo that proves the outcome. The AI resolver reads it
              and settles the market automatically.
            </p>
            <PhotoCapture
              facingMode="environment"
              captureLabel="Take photo"
              onCapture={setPhoto}
            />
            {error && <p className="text-sm text-no">{error}</p>}
            <div className="mt-auto">
              <Button
                loading={running}
                disabled={!photo || !user}
                onClick={resolve}
              >
                {running ? "Resolving…" : "Resolve market"}
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col gap-4">
            <Card className="space-y-3">
              {photo && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={photo}
                  alt="Resolution photo"
                  className="w-full rounded-xl object-cover"
                />
              )}
              <Step
                label="World · face match"
                ok={result.faceMatch.match}
                detail={`${Math.round(result.faceMatch.confidence * 100)}% confidence`}
              />
              <Step
                label="AI resolver · outcome"
                ok
                detail={result.outcome.toUpperCase()}
              />
              <p className="rounded-xl bg-surface-2 p-3 text-sm text-muted">
                “{result.description}”
              </p>
            </Card>
            <div className="mt-auto">
              <Button onClick={() => router.replace(`/markets/${marketId}`)}>
                See results
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Step({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2 text-sm">
        <span
          className={[
            "flex h-5 w-5 items-center justify-center rounded-full text-xs",
            ok ? "bg-yes/20 text-yes" : "bg-no/20 text-no",
          ].join(" ")}
        >
          {ok ? "✓" : "✕"}
        </span>
        {label}
      </span>
      <span className="text-sm font-semibold">{detail}</span>
    </div>
  );
}
