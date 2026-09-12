/**
 * Typed resolver errors. Dependency-free and **not** server-only, so routes,
 * `image-input.ts` and the AI stages can all share them without import cycles.
 */

export type ResolverErrorCode =
  | "invalid_image" // 400 — bad data URL / type / size
  | "not_configured" // 503 — no OPENAI_API_KEY in production
  | "refused" // 422 — model refused (safety)
  | "bad_output" // 502 — response didn't match schema
  | "upstream"; // 502 — API/network/timeout error

export type ResolverStage = "describe" | "validate";

export const RESOLVER_ERROR_STATUS: Readonly<Record<ResolverErrorCode, number>> =
  Object.freeze({
    invalid_image: 400,
    not_configured: 503,
    refused: 422,
    bad_output: 502,
    upstream: 502,
  });

export class ResolverError extends Error {
  readonly code: ResolverErrorCode;
  /** HTTP status to respond with. */
  readonly status: number;
  readonly stage: ResolverStage;

  constructor(
    stage: ResolverStage,
    code: ResolverErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ResolverError";
    this.stage = stage;
    this.code = code;
    this.status = RESOLVER_ERROR_STATUS[code];
  }
}

/** Kept for existing imports; same codes as `ResolverErrorCode`. */
export type DescribeErrorCode = ResolverErrorCode;
export type ValidateErrorCode = ResolverErrorCode;

/** Stage-1 (describe) failure, including invalid image input. */
export class DescribeError extends ResolverError {
  constructor(code: DescribeErrorCode, message: string, options?: { cause?: unknown }) {
    super("describe", code, message, options);
    this.name = "DescribeError";
  }
}

/** Stage-2 (validate) failure. */
export class ValidateError extends ResolverError {
  constructor(code: ValidateErrorCode, message: string, options?: { cause?: unknown }) {
    super("validate", code, message, options);
    this.name = "ValidateError";
  }
}

/** Construct the stage-specific subclass. */
export function resolverError(
  stage: ResolverStage,
  code: ResolverErrorCode,
  message: string,
): ResolverError {
  return stage === "describe"
    ? new DescribeError(code, message)
    : new ValidateError(code, message);
}
