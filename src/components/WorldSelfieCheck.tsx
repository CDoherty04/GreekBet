"use client";

/**
 * World Selfie Check gate — IDKit widget (live) or labeled stub (local demo).
 *
 * Opens World App for liveness / continuity. On success the parent receives
 * the verified nullifier (`worldId`) for signup or resolve.
 */

import { useCallback, useState } from "react";
import {
  IDKitRequestWidget,
  selfieCheckLegacy,
  type IDKitResult,
  type RpContext,
} from "@worldcoin/idkit";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import {
  worldActionId,
  worldAppId,
  worldEnvironment,
  type WorldAction,
} from "@/lib/world-public";

export interface WorldSelfieVerified {
  worldId: string;
  nullifier: string;
  stub: boolean;
}

interface Props {
  action: WorldAction;
  /** Bound into the proof (Privy id, wallet, or `userId:marketId`). */
  signal: string;
  /** Required when action is `resolve`. */
  marketId?: string;
  label?: string;
  disabled?: boolean;
  onVerified: (result: WorldSelfieVerified) => void;
  onError?: (message: string) => void;
}

export function WorldSelfieCheck({
  action,
  signal,
  marketId,
  label = "Verify with World Selfie Check",
  disabled,
  onVerified,
  onError,
}: Props) {
  const [open, setOpen] = useState(false);
  const [rpContext, setRpContext] = useState<RpContext | null>(null);
  const [idkitAction, setIdkitAction] = useState<string>("signup");
  const [stubMode, setStubMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const appId = worldAppId();

  const start = useCallback(async () => {
    setLoading(true);
    try {
      const actionId = worldActionId(action, marketId);
      setIdkitAction(actionId);
      const sig = await api.worldRpSignature(action, marketId);
      if (sig.stub || !appId) {
        setStubMode(true);
        const verified = await api.worldVerify({
          action,
          marketId,
          signal,
          stub: true,
        });
        setDone(true);
        onVerified({
          worldId: verified.worldId,
          nullifier: verified.nullifier,
          stub: true,
        });
        return;
      }

      setStubMode(false);
      setRpContext({
        rp_id: sig.rp_id,
        nonce: sig.nonce,
        created_at: sig.created_at,
        expires_at: sig.expires_at,
        signature: sig.sig,
      });
      setOpen(true);
    } catch (e) {
      onError?.(e instanceof Error ? e.message : "Could not start Selfie Check");
    } finally {
      setLoading(false);
    }
  }, [action, marketId, signal, appId, onVerified, onError]);

  if (done) {
    return (
      <p className="rounded-lg border border-yes/30 bg-yes/10 px-3 py-2 text-center text-sm text-yes">
        Selfie Check verified{stubMode ? " (dev stub)" : ""}
      </p>
    );
  }

  return (
    <>
      <Button
        loading={loading}
        disabled={disabled || loading}
        onClick={() => void start()}
      >
        {label}
      </Button>

      {rpContext && appId && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={appId}
          action={idkitAction}
          rp_context={rpContext}
          allow_legacy_proofs={true}
          environment={worldEnvironment()}
          preset={selfieCheckLegacy({ signal })}
          handleVerify={async (result: IDKitResult) => {
            const verified = await api.worldVerify({
              action,
              marketId,
              signal,
              idkitResult: result,
            });
            if (!verified.verified) {
              throw new Error("Backend rejected Selfie Check proof");
            }
            setDone(true);
            onVerified({
              worldId: verified.worldId,
              nullifier: verified.nullifier,
              stub: verified.stub,
            });
          }}
          onSuccess={() => {
            setOpen(false);
          }}
          onError={(code) => {
            onError?.(
              typeof code === "string"
                ? `Selfie Check failed: ${code}`
                : "Selfie Check failed",
            );
          }}
        />
      )}
    </>
  );
}
