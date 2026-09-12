/**
 * /api/markets/[marketId]/resolve — submit (POST) or clear (DELETE) a
 * resolution photo.
 *
 * POST runs the headline recipe, chaining sponsors:
 *   1. World Selfie Check — live human must vouch for this submission
 *      (proof consumed from /api/world/verify with action=resolve).
 *   2. Resolver → describe (OpenAI vision) → sanitize → validate
 *      (text-only) → policy.
 *
 * World gates *who* may submit. AI only judges *what* the event photo shows.
 *
 * The result is stored as a `ResolutionRecord`:
 *   - policy `auto`        → `pending`, `source: "ai"`, outcome = verdict;
 *   - policy `needs_owner` → `needs_owner`; the owner picks at `/resolve/confirm`.
 *
 * A `pending` record settles on chain once close time has passed — right here
 * if it already has, otherwise via a later trigger (market/group load, confirm,
 * or the owner's "Settle now"). Settlement is irreversible on chain.
 *
 * Replacement rule: once a record exists only the group owner may submit a new
 * photo (so a member can't re-roll an unfavourable verdict), and a record that
 * is `settling`/`settled` can't be replaced at all.
 *
 * Resolver failures (`ResolverError`) map to their own status — e.g. a bad
 * `imageDataUrl` is a 400 — and nothing is written to the market.
 *
 * See `docs/resolver/PLAN-2-validate-settle.md`.
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { toMarketView } from "@/lib/markets";
import {
  consumeVerifiedProof,
  worldActionId,
} from "@/lib/integrations/world";
import {
  resolveFromImage,
  type Resolution,
} from "@/lib/integrations/resolver";
import { ResolverError } from "@/lib/resolver/errors";
import { isSettleDue, settleMarket } from "@/lib/resolver/settle";
import type { ResolutionRecord } from "@/lib/resolver/types";
import { getChainMarket } from "@/lib/chain/projection";
import type { Group, Market, User } from "@/types";

interface ResolveBody {
  imageDataUrl: string;
  /** Nullifier from a fresh Selfie Check (action=resolve). */
  worldId: string;
}

/** Why `user` may not submit a photo over the market's current record, if so. */
function replacementBlocked(
  meta: Market,
  group: Group,
  user: User,
): string | null {
  const record = meta.resolution;
  if (!record) return null;
  if (record.status === "settling" || record.status === "settled") {
    return "This event is already being settled — the photo can't be replaced";
  }
  if (group.ownerId !== user.id) {
    return "A resolution photo was already submitted — only the group owner can replace it";
  }
  return null;
}

function buildRecord(
  prediction: Resolution,
  submittedBy: string,
  now: number,
): ResolutionRecord {
  const { validation, decision } = prediction;
  const auto = decision.action === "auto" && decision.outcome !== undefined;
  return {
    status: auto ? "pending" : "needs_owner",
    ...(auto ? { outcome: decision.outcome, source: "ai" as const } : {}),
    verdict: validation.verdict,
    confidence: validation.confidence,
    reasoning: validation.reasoning,
    evidence: validation.evidence,
    redFlags: validation.redFlags,
    policyReason: decision.reason,
    describeModel: prediction.describeModel,
    validateModel: validation.model,
    stub: prediction.describeStub || validation.stub,
    submittedBy,
    submittedAt: now,
    updatedAt: now,
    attempts: 0,
  };
}

export async function POST(
  req: Request,
  ctx: RouteContext<"/api/markets/[marketId]/resolve">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { marketId } = await ctx.params;
  const meta = await db.getMarket(marketId);
  if (!meta) return fail("Market not found", 404);

  const group = await db.getGroup(meta.groupId);
  if (!group?.memberIds.includes(user.id)) {
    return fail("Market not found", 404);
  }

  const chain = getChainMarket(marketId);
  if (!chain) return fail("Market is not indexed yet", 409);
  if (chain.status === "resolved") {
    return fail("Market is already resolved", 409);
  }

  const blocked = replacementBlocked(meta, group, user);
  if (blocked) return fail(blocked, 409);

  const body = await readJson<ResolveBody>(req);
  if (!body?.imageDataUrl) return fail("imageDataUrl is required");
  if (!body?.worldId) {
    return fail("Complete World Selfie Check before submitting a photo");
  }

  const signal = `${user.id}:${marketId}`;
  if (
    !consumeVerifiedProof({
      userId: user.id,
      action: worldActionId("resolve", marketId),
      signal,
      nullifier: body.worldId,
    })
  ) {
    return fail(
      "Selfie Check expired or missing — verify again, then submit",
      422,
    );
  }

  let prediction: Resolution;
  try {
    prediction = await resolveFromImage({
      question: meta.title,
      context: meta.description,
      imageDataUrl: body.imageDataUrl,
    });
  } catch (err) {
    // Nothing is persisted on failure.
    if (err instanceof ResolverError) return fail(err.message, err.status);
    console.error("[resolve] resolver failed", err);
    return fail("Could not analyze the photo", 502);
  }

  // The AI calls take seconds: re-check against the current state so a
  // concurrent submission, clear, or settle isn't overwritten.
  const current = await db.getMarket(marketId);
  if (!current) return fail("Market not found", 404);
  const blockedNow = replacementBlocked(current, group, user);
  if (blockedNow) return fail(blockedNow, 409);

  const record = buildRecord(prediction, user.id, Date.now());
  const { verdict, confidence } = prediction.validation;
  const updated = (await db.updateMarket(marketId, {
    resolution: record,
    resolutionImageUrl: body.imageDataUrl,
    resolutionNote: prediction.description,
    aiDescription: prediction.details,
    aiModel: prediction.describeModel,
    // Backwards-compatible mirrors of the verdict; `resolution` is the truth.
    aiPrediction: verdict === "yes" || verdict === "no" ? verdict : undefined,
    aiConfidence: confidence,
  }))!;

  const settle = isSettleDue(updated, getChainMarket(marketId))
    ? await settleMarket(marketId)
    : null;

  // `toMarketView` redacts for a non-owner submitter.
  return ok({
    market: await toMarketView(
      (await db.getMarket(marketId)) ?? updated,
      getChainMarket(marketId),
      user.walletAddress,
    ),
    settle,
    worldVerified: true,
  });
}

export async function DELETE(
  _req: Request,
  ctx: RouteContext<"/api/markets/[marketId]/resolve">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { marketId } = await ctx.params;
  const meta = await db.getMarket(marketId);
  if (!meta) return fail("Market not found", 404);

  const group = await db.getGroup(meta.groupId);
  if (!group?.memberIds.includes(user.id)) {
    return fail("Market not found", 404);
  }
  if (group.ownerId !== user.id) {
    return fail("Only the group owner can clear the resolution photo", 403);
  }

  const chain = getChainMarket(marketId);
  if (chain?.status === "resolved") {
    return fail("Market is already resolved", 409);
  }
  const status = meta.resolution?.status;
  if (status === "settling" || status === "settled") {
    return fail("This event is already being settled — the photo can't be cleared", 409);
  }

  const updated = (await db.updateMarket(marketId, {
    resolution: undefined,
    resolutionImageUrl: undefined,
    resolutionNote: undefined,
    aiDescription: undefined,
    aiModel: undefined,
    aiPrediction: undefined,
    aiConfidence: undefined,
  }))!;

  return ok({
    market: await toMarketView(updated, chain, user.walletAddress),
  });
}
