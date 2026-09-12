/**
 * Resolver stage 1 — describe a resolution photo with an OpenAI vision model.
 * **Server-only.**
 *
 * Returns a neutral, structured description (Structured Outputs, strict JSON
 * schema). It never decides the market; stage 2 does that from this output.
 *
 * Env (see `.env.example`):
 *   OPENAI_API_KEY       required in production; dev falls back to a stub
 *   OPENAI_VISION_MODEL  optional, default `gpt-5.6-terra`
 */

import "server-only";

import { DescribeError } from "./errors";
import { parseImageDataUrl } from "./image-input";
import { apiKey, DEFAULT_OPENAI_MODEL, runStructuredResponse } from "./openai";
import {
  buildDescribeUserText,
  DESCRIBE_INSTRUCTIONS,
  DESCRIPTION_JSON_SCHEMA,
  DESCRIPTION_SCHEMA_NAME,
} from "./prompt";

export { DescribeError, type DescribeErrorCode } from "./errors";

export interface ImageDescription {
  /** 1–3 sentence neutral summary of the scene. */
  summary: string;
  /** Concrete, visible facts — especially ones relevant to the question. */
  observations: string[];
  /** Each clearly visible person, labelled "Person 1", "Person 2", … in
   *  left-to-right order. Never names or identity guesses. Stable labels let
   *  stage 2 reason about who did what. */
  people: {
    label: string;
    /** Clothing, hair, accessories — visible traits only. */
    appearance: string;
    /** What they are doing / holding, as relevant to the question. */
    actions: string;
    /** Where in the frame, e.g. "left foreground". */
    position: string;
  }[];
  /** Legible text in the image, verbatim (signs, scoreboards, screens). */
  visibleText: string[];
  /** What cannot be determined, and why (blur, cropping, off-frame, ambiguity,
   *  signs the photo is a screen/print/edited). Empty if none. */
  limitations: string[];
  /** Overall usability of the photo as evidence. */
  imageQuality: "clear" | "partial" | "unusable";
}

export interface DescribeResult {
  description: ImageDescription;
  /** Model id that produced it, or "stub". */
  model: string;
  /** OpenAI response id for log correlation (not retrievable: requests use
   *  `store: false`); null for stub. */
  responseId: string | null;
  stub: boolean;
}

const QUALITIES: readonly ImageDescription["imageQuality"][] = [
  "clear",
  "partial",
  "unusable",
];

function visionModel(): string {
  return process.env.OPENAI_VISION_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
}

let warnedStub = false;

function stubResult(): DescribeResult {
  if (!warnedStub) {
    warnedStub = true;
    console.warn(
      "[resolver] OPENAI_API_KEY is not set — returning a STUB image description (development only).",
    );
  }
  return {
    description: {
      summary:
        "[STUB] No OPENAI_API_KEY is configured, so the photo was not analyzed. This is placeholder text.",
      observations: ["[STUB] Placeholder observation; nothing in the photo was examined."],
      people: [
        {
          label: "Person 1",
          appearance: "[STUB] placeholder appearance",
          actions: "[STUB] placeholder actions",
          position: "[STUB] center",
        },
      ],
      visibleText: [],
      limitations: ["Stub description: no vision model was called."],
      imageQuality: "unusable",
    },
    model: "stub",
    responseId: null,
    stub: true,
  };
}

function badOutput(message: string): DescribeError {
  return new DescribeError("bad_output", message);
}

function cleanString(value: unknown, field: string): string {
  if (typeof value !== "string") throw badOutput(`Field "${field}" is not a string`);
  return value.trim();
}

function cleanList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw badOutput(`Field "${field}" is not an array`);
  return value.map((v, i) => cleanString(v, `${field}[${i}]`)).filter(Boolean);
}

/** Validate the parsed model JSON against `ImageDescription` and normalize it. */
function toDescription(raw: unknown): ImageDescription {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw badOutput("Description is not a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const summary = cleanString(obj.summary, "summary");
  if (!summary) throw badOutput('Field "summary" is empty');

  if (!Array.isArray(obj.people)) throw badOutput('Field "people" is not an array');
  const people = obj.people
    .map((p, i) => {
      if (!p || typeof p !== "object" || Array.isArray(p)) {
        throw badOutput(`Field "people[${i}]" is not an object`);
      }
      const person = p as Record<string, unknown>;
      return {
        label: cleanString(person.label, `people[${i}].label`),
        appearance: cleanString(person.appearance, `people[${i}].appearance`),
        actions: cleanString(person.actions, `people[${i}].actions`),
        position: cleanString(person.position, `people[${i}].position`),
      };
    })
    .filter((p) => p.label || p.appearance || p.actions || p.position)
    .map((p, i) => ({ ...p, label: p.label || `Person ${i + 1}` }));

  const imageQuality = obj.imageQuality;
  if (!QUALITIES.includes(imageQuality as ImageDescription["imageQuality"])) {
    throw badOutput('Field "imageQuality" is not clear | partial | unusable');
  }

  return {
    summary,
    observations: cleanList(obj.observations, "observations"),
    people,
    visibleText: cleanList(obj.visibleText, "visibleText"),
    limitations: cleanList(obj.limitations, "limitations"),
    imageQuality: imageQuality as ImageDescription["imageQuality"],
  };
}

/**
 * Describe a resolution photo. Validates the image before any network call.
 * Throws `DescribeError` on every failure path.
 */
export async function describeImage(input: {
  imageDataUrl: string;
  /** Market title / yes-no question — focus hint only. */
  question: string;
  /** Optional market description for extra context. */
  context?: string;
}): Promise<DescribeResult> {
  parseImageDataUrl(input.imageDataUrl);

  const key = apiKey();
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      throw new DescribeError(
        "not_configured",
        "Image description is not configured (OPENAI_API_KEY is missing)",
      );
    }
    return stubResult();
  }

  const result = await runStructuredResponse({
    stage: "describe",
    key,
    model: visionModel(),
    instructions: DESCRIBE_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildDescribeUserText(input.question, input.context),
          },
          {
            type: "input_image",
            image_url: input.imageDataUrl,
            detail: "high",
          },
        ],
      },
    ],
    schemaName: DESCRIPTION_SCHEMA_NAME,
    schema: DESCRIPTION_JSON_SCHEMA,
    requestLabel: "Vision request",
    refusalAction: "describe the image",
  });

  return {
    description: toDescription(result.parsed),
    model: result.model,
    responseId: result.responseId,
    stub: false,
  };
}

/** Flatten to plain text for `resolutionNote` and for the stage-2 prompt. */
export function formatDescription(d: ImageDescription): string {
  const lines: string[] = [`Summary: ${d.summary}`];
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`${title}:`, ...items.map((item) => `- ${item}`));
  };

  section("Observations", d.observations);
  section(
    "People",
    d.people.map((p) => {
      const where = p.position ? ` (${p.position})` : "";
      const details = [p.appearance, p.actions].filter(Boolean).join("; ");
      return `${p.label}${where}${details ? `: ${details}` : ""}`;
    }),
  );
  section("Visible text", d.visibleText);
  section("Limitations", d.limitations);
  lines.push(`Image quality: ${d.imageQuality}`);
  return lines.join("\n");
}
