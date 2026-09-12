/**
 * POST /api/world/verify — verify a Selfie Check IDKit proof.
 *
 * Forwards the IDKit result unchanged to Developer Portal /v4/verify,
 * binds signal, and stores the nullifier (anti-replay).
 */

import { fail, ok, readJson } from "@/lib/http";
import { getPrivyId } from "@/lib/session";
import {
  WORLD_ACTIONS,
  buildStubIdKitResult,
  rememberVerifiedProof,
  verifySelfieProof,
  worldActionId,
  type StubIdKitResult,
  type WorldAction,
} from "@/lib/integrations/world";
import type { IDKitResult } from "@worldcoin/idkit-core";

interface Body {
  action?: string;
  marketId?: string;
  signal?: string;
  /** Full IDKit result, or omit with `stub: true` for local demos. */
  idkitResult?: IDKitResult | StubIdKitResult;
  stub?: boolean;
}

export async function POST(req: Request) {
  const privyId = await getPrivyId();
  if (!privyId) return fail("Not signed in", 401);

  const body = await readJson<Body>(req);
  if (!body) return fail("Invalid JSON body");
  const action = body.action as WorldAction | undefined;
  if (!action || !(action in WORLD_ACTIONS)) {
    return fail('action must be "signup" or "resolve"');
  }
  if (action === "resolve" && !body.marketId) {
    return fail("marketId is required for resolve");
  }

  const signal = body.signal?.trim() || privyId;
  const actionId = worldActionId(action, body.marketId);

  try {
    const idkitResult =
      body.idkitResult ??
      (body.stub
        ? buildStubIdKitResult({ action: actionId, signal })
        : null);

    if (!idkitResult) {
      return fail("idkitResult is required (or stub: true)");
    }

    const verified = await verifySelfieProof({
      action: actionId,
      signal,
      idkitResult,
    });

    rememberVerifiedProof({
      userId: privyId,
      action: actionId,
      signal,
      nullifier: verified.nullifier,
    });

    return ok({
      verified: verified.verified,
      stub: verified.stub,
      nullifier: verified.nullifier,
      worldId: verified.nullifier,
      identifier: verified.identifier,
      action: verified.action,
    });
  } catch (err) {
    console.error("[world/verify]", err);
    return fail(
      err instanceof Error ? err.message : "Selfie Check verification failed",
      422,
    );
  }
}
