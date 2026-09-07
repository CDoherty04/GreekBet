/**
 * AI Resolver — the "Bazantic recipe" (STUB).
 *
 * Bounty: best recipe that chains sponsor APIs. This is our headline
 * endpoint: given a market question and an uploaded photo, it runs a small
 * pipeline and returns a yes/no outcome that settles the market.
 *
 * The recipe (each step is a seam a real API can slot into):
 *   1. describe   — vision model turns the photo into a text description.
 *   2. sanitize   — strip PII / unsafe content from that description.
 *   3. decide     — reasoning model answers the market's yes/no question
 *                   using only the sanitized description.
 *
 * TODO(real): swap each step for the corresponding sponsor API. Keep
 * `resolveFromImage` returning the same `Resolution` shape.
 */

import type { Side } from "@/types";

export interface Resolution {
  outcome: Side;
  /** Sanitized description of the photo that the decision was based on. */
  description: string;
  /** 0..1 confidence in the outcome. */
  confidence: number;
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Step 1: vision model → raw description of the image. */
async function describeImage(_imageUrl: string): Promise<string> {
  await delay(800);
  // STUB: pretend a vision model returned this.
  return "A group of friends at a restaurant table; one person has finished a large burrito, empty plate in front of them, smiling.";
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
  // STUB: naive keyword heuristic so the demo is deterministic-ish.
  const text = `${question} ${description}`.toLowerCase();
  const positive = /(finish|won|complete|did|success|empty plate|yes)/.test(
    text,
  );
  return { outcome: positive ? "yes" : "no", confidence: 0.88 };
}

/**
 * Run the full resolution recipe for a market.
 * @param question the market title / yes-no question
 * @param imageUrl the uploaded resolution photo
 */
export async function resolveFromImage(
  question: string,
  imageUrl: string,
): Promise<Resolution> {
  const raw = await describeImage(imageUrl);
  const description = sanitize(raw);
  const { outcome, confidence } = await decide(question, description);
  return { outcome, description, confidence };
}
