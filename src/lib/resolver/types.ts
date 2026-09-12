/**
 * Shared resolver types for stages 2–3 (validate, policy, settle).
 *
 * Type-only and **not** server-only: the client imports `ResolutionView` via
 * `@/types`. Keep runtime code out of this file.
 *
 * Frozen by `docs/resolver/PLAN-2-validate-settle.md` — tickets R4–R7 build
 * against these shapes.
 */

import type { ImageDescription } from "./describe";

export type { ImageDescription };

/** Stage-2 answer. `neither` = the description can't settle the question. */
export type Verdict = "yes" | "no" | "neither";

/** Output of `validateDescription` (stage 2). */
export interface ValidationResult {
  verdict: Verdict;
  /** 0..1 confidence in `verdict`. */
  confidence: number;
  /** 1–3 sentences explaining the verdict, citing the description. */
  reasoning: string;
  /** Items from the description (observations / visible text) relied on. */
  evidence: string[];
  /**
   * Reasons this should not be auto-resolved even if the verdict looks clear:
   * possible edit/screen/printout, description contradicts itself, question
   * terms not observable (e.g. a deadline with no visible time), ambiguity
   * about which person the question means. Empty if none.
   */
  redFlags: string[];
  /** Model id, or "stub". */
  model: string;
  responseId: string | null;
  stub: boolean;
}

/** Output of `decideResolution` (policy). */
export interface PolicyDecision {
  action: "auto" | "needs_owner";
  /** Set when `action === "auto"`. */
  outcome?: "yes" | "no";
  /** Human-readable reason, e.g. "Confidence 0.62 is below 0.85". */
  reason: string;
}

export type ResolutionStatus =
  /** Outcome chosen (AI or owner); waiting for close time / a settle trigger. */
  | "pending"
  /** Close/resolve transaction in flight. */
  | "settling"
  /** Resolved on chain. */
  | "settled"
  /** AI couldn't auto-resolve; the owner must pick YES/NO. */
  | "needs_owner"
  /** Last settle attempt failed; retried on the next trigger. */
  | "failed";

/** Server-side resolution state, stored on `Market.resolution`. */
export interface ResolutionRecord {
  status: ResolutionStatus;
  /** Outcome to write / written. Absent while `needs_owner`. */
  outcome?: "yes" | "no";
  /** Who chose `outcome`. */
  source?: "ai" | "owner";

  /** Stage-2 output (verdict may differ from `outcome` if the owner overrode). */
  verdict: Verdict;
  confidence: number;
  reasoning: string;
  evidence: string[];
  redFlags: string[];
  /** Policy reason — why it auto-resolved or why it needs the owner. */
  policyReason: string;

  describeModel: string;
  validateModel: string;
  /** True if either AI stage was a stub. */
  stub: boolean;

  /** User id of the member who submitted the photo. */
  submittedBy: string;
  /** Unix ms. */
  submittedAt: number;
  /** Unix ms of the last status change. */
  updatedAt: number;

  closeSignature?: string;
  resolveSignature?: string;
  /** Unix ms, when `settled`. */
  settledAt?: number;
  /** Last settle error message, when `failed`. */
  error?: string;
  /** Settle attempts so far. */
  attempts: number;
}

/**
 * What a viewer receives on `MarketView.resolution`.
 *
 * Non-owners get the redacted form until the market is resolved on chain, so a
 * pending verdict can't be traded on.
 */
export type ResolutionView =
  | ({ redacted: false } & ResolutionRecord)
  | {
      redacted: true;
      status: ResolutionStatus;
      submittedBy: string;
      submittedAt: number;
    };

/** Result of one `settleMarket` call. */
export type SettleResult =
  | { state: "settled"; outcome: "yes" | "no"; signature: string | null }
  /** Close time not reached; `closesAt` is unix ms. */
  | { state: "waiting"; closesAt: number }
  /** Nothing to do (no record, `needs_owner`, already in flight, …). */
  | { state: "skipped"; reason: string }
  | { state: "failed"; error: string };
