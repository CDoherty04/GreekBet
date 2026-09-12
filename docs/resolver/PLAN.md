# AI Resolver — Plan

The resolver settles a market from a photo in three stages:

1. **Describe** — a vision model turns the photo into a neutral, structured
   description. *(This phase.)*
2. **Validate** — a reasoning model decides whether that description supports
   YES, NO, or neither. *(Next phase.)*
3. **Resolve** — the outcome is written on chain via the existing
   `/resolve/confirm` flow. *(Later phase.)*

This document covers stage 1 and freezes the interface stages 2–3 build on.

## Current state

- `src/lib/integrations/resolver.ts` is a stub: `describeImage` returns a canned
  string, `sanitize` regex-redacts phones/emails, `decide` is a keyword heuristic.
- `POST /api/markets/[marketId]/resolve` receives `imageDataUrl` (a
  `data:image/jpeg;base64,…` from `PhotoCapture`, JPEG q0.8), calls
  `resolveFromImage(meta.title, imageDataUrl)`, and stores `resolutionNote`,
  `aiPrediction`, `aiConfidence` on the off-chain `Market`. It has no error
  handling around the resolver.
- No OpenAI dependency or env var exists yet.

## Design decisions

1. **OpenAI Responses API via the official `openai` npm SDK.** Image is passed
   as an `input_image` content part with the base64 data URL
   (`image_url: "data:image/jpeg;base64,…"`). No upload to the Files API — the
   photo is already a data URL in the request.
2. **Model is configurable**, default `gpt-5.6-terra` (balances accuracy and
   cost; a single photo per resolution is cheap, and a wrong description moves
   real collateral). Override with `OPENAI_VISION_MODEL`. `detail: "high"`.
3. **Description is observational, not a verdict.** The model receives the
   market question *only as a focus hint* ("pay attention to details relevant
   to …") and is explicitly instructed not to say whether the event happened.
   Keeping stage 1 blind to the verdict is what makes stage 2's check
   meaningful — otherwise the describer just pre-decides.
4. **Structured Outputs** (`text.format` with a strict JSON schema) so stage 2
   receives predictable fields rather than prose. See the frozen interface.
5. **Privacy:** the prompt forbids identifying people by name or guessing
   identity; describe people by visible appearance/actions only. The existing
   `sanitize` pass still runs on the flattened text.
6. **Input validation on the server** before any API call: must be a
   `data:` URL with MIME `image/jpeg | image/png | image/webp | image/gif`, valid
   base64, decoded size ≤ 10 MB.
7. **Missing key:** in development (`NODE_ENV !== "production"`) fall back to a
   clearly-flagged stub (`stub: true`) and log a one-time warning, so the app
   still runs without a key. In production a missing key is a hard
   `not_configured` error — a fake description must never reach an owner who is
   about to write an irreversible on-chain outcome.
8. **Errors are typed** (`DescribeError` with a code + HTTP status) so the route
   returns a clean 4xx/5xx instead of an unhandled 500. Request timeout 60 s,
   SDK retries left at default (2).

## Frozen interface

`src/lib/resolver/describe.ts` (server-only):

```ts
export interface ImageDescription {
  /** 1–3 sentence neutral summary of the scene. */
  summary: string;
  /** Concrete, visible facts — especially ones relevant to the question. */
  observations: string[];
  /** Each clearly visible person, labelled "Person 1", "Person 2", … in
   *  left-to-right order. Never names or identity guesses. Stable labels let
   *  stage 2 reason about who did what, and leave room for a future
   *  member-matching step to join on `label`. */
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
  /** OpenAI response id for audit/debugging; null for stub. */
  responseId: string | null;
  stub: boolean;
}

export type DescribeErrorCode =
  | "invalid_image"   // 400 — bad data URL / type / size
  | "not_configured"  // 503 — no OPENAI_API_KEY in production
  | "refused"         // 422 — model refused (safety)
  | "bad_output"      // 502 — response didn't match schema
  | "upstream";       // 502 — API/network/timeout error

export class DescribeError extends Error {
  readonly code: DescribeErrorCode;
  readonly status: number;
}

export function describeImage(input: {
  imageDataUrl: string;
  /** Market title / yes-no question — focus hint only. */
  question: string;
  /** Optional market description for extra context. */
  context?: string;
}): Promise<DescribeResult>;

/** Flatten to plain text for `resolutionNote` and for the stage-2 prompt. */
export function formatDescription(d: ImageDescription): string;
```

`src/lib/resolver/image-input.ts`:

```ts
export const ALLOWED_IMAGE_TYPES: readonly string[];
export const MAX_IMAGE_BYTES: number; // 10 * 1024 * 1024
/** Throws DescribeError("invalid_image") on failure. */
export function parseImageDataUrl(dataUrl: string): { mimeType: string; bytes: number };
```

## Tickets

| ID | Title | Depends on | Owns |
|---|---|---|---|
| [R1](./tickets/R1-describe-module.md) | OpenAI vision describe module | — | `src/lib/resolver/**`, `package.json`, `package-lock.json`, `.env.example` |
| [R2](./tickets/R2-describe-cli.md) | Describe CLI for manual testing | R1 | `scripts/describe-image.ts` |
| [R3](./tickets/R3-wire-into-resolve.md) | Wire describe into the resolve route | R1 | `src/lib/integrations/resolver.ts`, `src/app/api/markets/[marketId]/resolve/route.ts`, `src/types/index.ts` |

```
Wave 1   R1
Wave 2   R2  R3   (parallel)
```

**Status (2026-09-12):** R1, R2, R3 done. `npx tsc --noEmit` and eslint on all
resolver files pass. The live OpenAI path has not been exercised yet (no
`OPENAI_API_KEY` configured) — only stub mode and mocked responses.

## Rules for every ticket

1. Stay inside your file scope. If you need a change elsewhere, say so in your
   report instead of making it.
2. This is Next.js 16 — read the relevant guide in `node_modules/next/dist/docs/`
   before writing route or config code.
3. Do not change the frozen interface. If it is wrong, report why.
4. Report honestly: include `npx tsc --noEmit` and `npm run lint` results, and
   say plainly what was and wasn't run against the live API.
5. Never print, log, or commit the value of `OPENAI_API_KEY`.

## Out of scope (next phases)

- Stage 2 validate (YES / NO / neither) and replacing the `decide` stub.
- Showing structured observations in the resolve page UI.
- Auto-resolution without owner confirmation.
- Matching people in the photo to members' profile selfies (deferred). Note
  for when it's picked up: World Selfie Check only returns a proof that a user
  passed liveness against their own World enrollment — it exposes no face data
  and cannot compare faces in an arbitrary photo, so matching would need a
  dedicated face-comparison service. Subjects would be inferred from member
  names in the market title.
