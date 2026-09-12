/**
 * AI Resolver — the "Bazantic recipe". **Server-only.**
 *
 * Bounty: best recipe that chains sponsor APIs. This is our headline
 * endpoint: given a market question and an uploaded photo, it runs a small
 * pipeline and returns a verdict plus a policy decision on whether that verdict
 * may settle the market with no human step.
 *
 * The recipe:
 *   1. describe   — an OpenAI vision model turns the photo into a neutral,
 *                   structured description (`@/lib/resolver/describe`).
 *   2. sanitize   — strip PII from every description field before it is stored,
 *                   shown, or passed on.
 *   3. validate   — a text-only OpenAI call answers the question yes / no /
 *                   neither from the sanitized description alone
 *                   (`@/lib/resolver/validate`). It never sees the photo.
 *   4. policy     — `decideResolution` (`@/lib/resolver/policy`) says `auto`
 *                   (clear, confident, unflagged yes/no) or `needs_owner`.
 *
 * In development without `OPENAI_API_KEY` both AI stages return flagged stubs,
 * which the policy always routes to the owner.
 *
 * Nothing here touches the store or the chain: the resolve route persists the
 * record and the settlement service (`@/lib/resolver/settle`) writes on chain.
 * Failures surface as `ResolverError` (typed code + HTTP status) so the route
 * can return a clean 4xx/5xx.
 */

import "server-only";

import {
  describeImage,
  formatDescription,
  type ImageDescription,
} from "@/lib/resolver/describe";
import { decideResolution } from "@/lib/resolver/policy";
import type { PolicyDecision, ValidationResult } from "@/lib/resolver/types";
import { validateDescription } from "@/lib/resolver/validate";

export interface Resolution {
  /** Sanitized, flattened description of the photo. */
  description: string;
  /** Structured description from the vision model, each field sanitized. */
  details: ImageDescription;
  /** Model id that produced the description, or "stub". */
  describeModel: string;
  /** True when no vision model was called (dev without a key). */
  describeStub: boolean;
  /** Stage-2 verdict, read from `details` only. */
  validation: ValidationResult;
  /** Whether the verdict may auto-resolve, and why. */
  decision: PolicyDecision;
}

/** Remove anything sensitive before it is stored or reaches the validator. */
function sanitize(description: string): string {
  return description
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[redacted-phone]")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[redacted-email]")
    .trim();
}

function sanitizeDetails(raw: ImageDescription): ImageDescription {
  return {
    ...raw,
    summary: sanitize(raw.summary),
    observations: raw.observations.map(sanitize),
    people: raw.people.map((p) => ({
      label: p.label,
      appearance: sanitize(p.appearance),
      actions: sanitize(p.actions),
      position: sanitize(p.position),
    })),
    visibleText: raw.visibleText.map(sanitize),
    limitations: raw.limitations.map(sanitize),
  };
}

/**
 * Run the full resolution recipe for a market: describe → sanitize → validate
 * → policy. Throws `ResolverError` (`DescribeError` / `ValidateError`) if the
 * photo is invalid or either AI stage fails.
 */
export async function resolveFromImage(input: {
  /** The market title / yes-no question. */
  question: string;
  /** Optional market description for extra context. */
  context?: string;
  /** The resolution photo as a base64 `data:` URL. */
  imageDataUrl: string;
}): Promise<Resolution> {
  const described = await describeImage({
    imageDataUrl: input.imageDataUrl,
    question: input.question,
    context: input.context,
  });

  // Sanitize the structured fields too: they are persisted and shown to the
  // owner (and to everyone once resolved), not just the flattened text.
  const details = sanitizeDetails(described.description);
  const description = sanitize(formatDescription(details));

  const validation = await validateDescription({
    question: input.question,
    context: input.context,
    description: details,
    describeStub: described.stub,
  });

  const decision = decideResolution({
    description: details,
    describeStub: described.stub,
    validation,
  });

  return {
    description,
    details,
    describeModel: described.model,
    describeStub: described.stub,
    validation,
    decision,
  };
}
