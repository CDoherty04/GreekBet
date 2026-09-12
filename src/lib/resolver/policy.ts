/**
 * Auto-resolve policy (resolver stage 3, decision half).
 *
 * Decides whether a stage-2 verdict may settle a market with no human step, or
 * whether the group owner has to pick YES/NO. Pure: no I/O, no clock, and not
 * server-only — the only environment read is the threshold, which callers can
 * override.
 *
 * See `docs/resolver/PLAN-2-validate-settle.md`, decision 1.
 */

import type {
  ImageDescription,
  PolicyDecision,
  ValidationResult,
} from "./types";

export const DEFAULT_AUTO_CONFIDENCE = 0.85;

/** A usable threshold is a finite number in (0, 1]. */
function isValidThreshold(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 1;
}

/** RESOLVER_AUTO_CONFIDENCE, validated to (0,1]; falls back to the default. */
export function autoConfidenceThreshold(): number {
  const raw = process.env.RESOLVER_AUTO_CONFIDENCE?.trim();
  if (!raw) return DEFAULT_AUTO_CONFIDENCE;
  const value = Number(raw);
  return isValidThreshold(value) ? value : DEFAULT_AUTO_CONFIDENCE;
}

/**
 * Two decimals, unless that would make a below-threshold confidence print the
 * same as the threshold ("0.85 is below 0.85").
 */
function formatConfidence(confidence: number, threshold: number): string {
  const short = confidence.toFixed(2);
  if (confidence < threshold && short === threshold.toFixed(2)) {
    return confidence.toFixed(4);
  }
  return short;
}

/**
 * Checked in order, first failure wins: stub → `neither` → image quality →
 * red flags → confidence. Otherwise `auto` with `outcome = verdict`.
 */
export function decideResolution(input: {
  description: ImageDescription;
  describeStub: boolean;
  validation: ValidationResult;
  threshold?: number;
}): PolicyDecision {
  const { description, describeStub, validation } = input;
  const threshold =
    input.threshold !== undefined && isValidThreshold(input.threshold)
      ? input.threshold
      : autoConfidenceThreshold();

  const needsOwner = (reason: string): PolicyDecision => ({
    action: "needs_owner",
    reason,
  });

  if (describeStub || validation.stub) {
    return needsOwner(
      "The AI resolver isn't configured, so the owner needs to confirm.",
    );
  }

  const { verdict, confidence, redFlags } = validation;
  if (verdict !== "yes" && verdict !== "no") {
    return needsOwner("The photo doesn't clearly answer the question.");
  }

  if (description.imageQuality !== "clear") {
    return needsOwner(
      `The photo is ${description.imageQuality === "partial" ? "only partly clear" : "unusable"}, so the owner needs to confirm.`,
    );
  }

  if (redFlags.length > 0) {
    const first = redFlags[0]!.trim().replace(/[.\s]+$/, "");
    const more = redFlags.length > 1 ? ` (+${redFlags.length - 1} more)` : "";
    return needsOwner(`Flagged for review: ${first}${more}.`);
  }

  // NaN compares false against everything, so check finiteness explicitly —
  // otherwise a malformed confidence would sail through to `auto`.
  if (!Number.isFinite(confidence) || confidence < threshold) {
    return needsOwner(
      Number.isFinite(confidence)
        ? `Confidence ${formatConfidence(confidence, threshold)} is below ${threshold.toFixed(2)}.`
        : "The AI didn't report a usable confidence.",
    );
  }

  return {
    action: "auto",
    outcome: verdict,
    reason: `The AI read ${verdict.toUpperCase()} from a clear photo with ${confidence.toFixed(2)} confidence.`,
  };
}
