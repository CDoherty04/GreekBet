/**
 * Resolver stage 2 — decide YES / NO / neither from the stage-1 description.
 * **Server-only.** Text-only: the validator never sees the photo.
 *
 * Env (see `.env.example`):
 *   OPENAI_API_KEY          required in production; dev falls back to a stub
 *   OPENAI_VALIDATOR_MODEL  optional, default `gpt-5.6-terra`
 */

import "server-only";

import type { ImageDescription } from "./describe";
import { ValidateError } from "./errors";
import { apiKey, DEFAULT_OPENAI_MODEL, runStructuredResponse } from "./openai";
import type { ValidationResult, Verdict } from "./types";
import {
  buildValidateUserText,
  VALIDATE_INSTRUCTIONS,
  VALIDATION_JSON_SCHEMA,
  VALIDATION_SCHEMA_NAME,
} from "./validate-prompt";

export { ValidateError } from "./errors";

const VERDICTS: readonly Verdict[] = ["yes", "no", "neither"];

function validatorModel(): string {
  return process.env.OPENAI_VALIDATOR_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
}

let warnedStub = false;

function stubResult(reasoning: string): ValidationResult {
  return {
    verdict: "neither",
    confidence: 0,
    reasoning,
    evidence: [],
    redFlags: [],
    model: "stub",
    responseId: null,
    stub: true,
  };
}

function badOutput(message: string): ValidateError {
  return new ValidateError("bad_output", message);
}

function cleanList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw badOutput(`Field "${field}" is not an array`);
  return value
    .map((v, i) => {
      if (typeof v !== "string") throw badOutput(`Field "${field}[${i}]" is not a string`);
      return v.trim();
    })
    .filter(Boolean);
}

/** Validate the parsed model JSON and normalize it (trim, drop empties, clamp). */
function toValidation(raw: unknown): Pick<
  ValidationResult,
  "verdict" | "confidence" | "reasoning" | "evidence" | "redFlags"
> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw badOutput("Validation is not a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const verdict = typeof obj.verdict === "string" ? obj.verdict.trim() : obj.verdict;
  if (!VERDICTS.includes(verdict as Verdict)) {
    throw badOutput('Field "verdict" is not yes | no | neither');
  }

  if (typeof obj.confidence !== "number" || !Number.isFinite(obj.confidence)) {
    throw badOutput('Field "confidence" is not a number');
  }
  const confidence = Math.min(1, Math.max(0, obj.confidence));

  if (typeof obj.reasoning !== "string") throw badOutput('Field "reasoning" is not a string');

  return {
    verdict: verdict as Verdict,
    confidence,
    reasoning: obj.reasoning.trim(),
    evidence: cleanList(obj.evidence, "evidence"),
    redFlags: cleanList(obj.redFlags, "redFlags"),
  };
}

/**
 * Decide the market question from a stage-1 description.
 *
 * Returns a stub (`verdict: "neither"`, `stub: true`) if the description was a
 * stub, or if no API key is set outside production. Throws `ValidateError` on
 * every failure path (`not_configured` when production has no key).
 */
export async function validateDescription(input: {
  question: string;
  context?: string;
  description: ImageDescription;
  describeStub: boolean;
}): Promise<ValidationResult> {
  if (input.describeStub) {
    return stubResult(
      "[STUB] The image description was a placeholder (no vision model ran), so there is nothing to validate.",
    );
  }

  const key = apiKey();
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      throw new ValidateError(
        "not_configured",
        "Resolution validation is not configured (OPENAI_API_KEY is missing)",
      );
    }
    if (!warnedStub) {
      warnedStub = true;
      console.warn(
        "[resolver] OPENAI_API_KEY is not set — returning a STUB validation (development only).",
      );
    }
    return stubResult(
      "[STUB] No OPENAI_API_KEY is configured, so the description was not validated.",
    );
  }

  const result = await runStructuredResponse({
    stage: "validate",
    key,
    model: validatorModel(),
    instructions: VALIDATE_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: buildValidateUserText(input) }],
      },
    ],
    schemaName: VALIDATION_SCHEMA_NAME,
    schema: VALIDATION_JSON_SCHEMA,
    requestLabel: "Validation request",
    refusalAction: "validate the description",
  });

  return {
    ...toValidation(result.parsed),
    model: result.model,
    responseId: result.responseId,
    stub: false,
  };
}
