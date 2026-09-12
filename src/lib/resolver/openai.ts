/**
 * Shared OpenAI plumbing for the resolver stages. **Server-only.**
 *
 * One lazily-created client, key lookup, key scrubbing for error messages, and
 * a helper that runs a strict Structured Outputs Responses call and returns the
 * parsed JSON — mapping every failure to a stage-specific `ResolverError`.
 */

import "server-only";

import OpenAI from "openai";
import type {
  Response as OpenAIResponse,
  ResponseInput,
} from "openai/resources/responses/responses";

import { resolverError, type ResolverStage } from "./errors";

/** Default model for both stages unless overridden by env. */
export const DEFAULT_OPENAI_MODEL = "gpt-5.6-terra";

export function apiKey(): string | undefined {
  return process.env.OPENAI_API_KEY?.trim() || undefined;
}

let client: OpenAI | null = null;
let clientKey: string | null = null;

export function getClient(key: string): OpenAI {
  if (!client || clientKey !== key) {
    client = new OpenAI({ apiKey: key, timeout: 60_000 });
    clientKey = key;
  }
  return client;
}

/** Strip anything key-shaped (and the configured key itself) from a message. */
export function scrub(message: string): string {
  let out = message.replace(/\bsk-[A-Za-z0-9_*-]{4,}/g, "[redacted-key]");
  const key = apiKey();
  if (key) out = out.split(key).join("[redacted-key]");
  return out;
}

function findRefusal(response: OpenAIResponse): string | null {
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type === "refusal") return part.refusal.trim() || "Model refused";
    }
  }
  return null;
}

export interface StructuredCall {
  stage: ResolverStage;
  key: string;
  model: string;
  instructions: string;
  input: ResponseInput;
  schemaName: string;
  schema: { [key: string]: unknown };
  /** Error-message wording, e.g. "Vision request" → "Vision request failed: …". */
  requestLabel: string;
  /** e.g. "describe the image" → "Model refused to describe the image: …". */
  refusalAction: string;
}

export interface StructuredResult {
  /** Parsed JSON; shape still unchecked — callers validate it. */
  parsed: unknown;
  /** Model id reported by the API, else the requested one. */
  model: string;
  responseId: string | null;
}

/**
 * Run a strict-json_schema Responses call with `store: false` and parse the
 * output. Throws `DescribeError` / `ValidateError` (per `stage`) with code
 * `upstream`, `refused` or `bad_output`.
 */
export async function runStructuredResponse(call: StructuredCall): Promise<StructuredResult> {
  const fail = (code: Parameters<typeof resolverError>[1], message: string) =>
    resolverError(call.stage, code, message);

  let response: OpenAIResponse;
  try {
    response = await getClient(call.key).responses.create({
      model: call.model,
      // Resolver inputs concern group members: never retain them at OpenAI.
      store: false,
      instructions: call.instructions,
      input: call.input,
      text: {
        format: {
          type: "json_schema",
          name: call.schemaName,
          schema: call.schema,
          strict: true,
        },
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw fail("upstream", scrub(`${call.requestLabel} failed: ${message}`));
  }

  const refusal = findRefusal(response);
  if (refusal) {
    throw fail("refused", scrub(`Model refused to ${call.refusalAction}: ${refusal}`));
  }

  if (response.status === "failed") {
    throw fail(
      "upstream",
      scrub(`${call.requestLabel} failed: ${response.error?.message ?? "unknown error"}`),
    );
  }
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason ?? "unknown";
    if (reason === "content_filter") {
      throw fail("refused", "Model output was blocked by the content filter");
    }
    throw fail("bad_output", `Model output was incomplete (${reason})`);
  }

  const text = response.output_text?.trim();
  if (!text) throw fail("bad_output", "Model returned no output");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail("bad_output", "Model output is not valid JSON");
  }

  return {
    parsed,
    model: response.model || call.model,
    responseId: response.id ?? null,
  };
}
