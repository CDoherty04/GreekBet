/**
 * AI Resolver — the "Bazantic recipe". **Server-only.**
 *
 * Bounty: best recipe that chains sponsor APIs. This is our headline
 * endpoint: given a market question and an uploaded photo, it runs a small
 * pipeline and returns a *suggested* yes/no outcome for the owner to confirm.
 *
 * The recipe:
 *   1. describe   — REAL. An OpenAI vision model turns the photo into a
 *                   neutral, structured description (`@/lib/resolver/describe`).
 *                   In development without `OPENAI_API_KEY` it returns a
 *                   flagged stub (`stub: true`).
 *   2. sanitize   — strip PII from the flattened description text.
 *   3. decide     — STILL A STUB. A keyword heuristic stands in for the
 *                   stage-2 reasoning model, which will answer the question
 *                   from the sanitized description only.
 *
 * Failures from describe surface as `DescribeError` (typed code + HTTP status)
 * so the route can return a clean 4xx/5xx.
 */

import "server-only";

import {
  describeImage,
  formatDescription,
  type ImageDescription,
} from "@/lib/resolver/describe";
import type { Side } from "@/types";

export interface Resolution {
  outcome: Side;
  /** Sanitized, flattened description of the photo the decision was based on. */
  description: string;
  /** 0..1 confidence in the outcome. */
  confidence: number;
  /** Structured description from the vision model, each field sanitized. */
  details: ImageDescription;
  /** Model id that produced the description, or "stub". */
  model: string;
  /** True when no vision model was called (dev without a key). */
  stub: boolean;
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Step 2: remove anything sensitive before it reaches the decision model. */
function sanitize(description: string): string {
  return description
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[redacted-phone]")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[redacted-email]")
    .trim();
}

/** Step 3: reasoning model → yes/no answer to the market question. */
async function decide(
  question: string,
  description: string,
): Promise<{ outcome: Side; confidence: number }> {
  await delay(700);
  // STUB: naive keyword heuristic until stage 2 (validate) replaces it.
  const text = `${question} ${description}`.toLowerCase();
  const positive = /(finish|won|complete|did|success|empty plate|yes)/.test(
    text,
  );
  return { outcome: positive ? "yes" : "no", confidence: 0.88 };
}

/**
 * Run the full resolution recipe for a market.
 * Throws `DescribeError` if the photo is invalid or can't be described.
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
  // Sanitize the structured fields too: they are persisted and sent to every
  // group member via `MarketView`, not just the flattened text.
  const raw = described.description;
  const details: ImageDescription = {
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
  const description = sanitize(formatDescription(details));
  const decided = await decide(input.question, description);
  // An unusable photo teaches the heuristic nothing — don't pretend otherwise.
  const confidence = details.imageQuality === "unusable" ? 0 : decided.confidence;

  return {
    outcome: decided.outcome,
    description,
    confidence,
    details,
    model: described.model,
    stub: described.stub,
  };
}
