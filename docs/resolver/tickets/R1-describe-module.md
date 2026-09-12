# R1 — OpenAI vision describe module

**Depends on:** — · **Blocks:** R2, R3
**Owns:** `src/lib/resolver/describe.ts`, `src/lib/resolver/image-input.ts`,
`src/lib/resolver/prompt.ts`, `package.json`, `package-lock.json`, `.env.example`

Read [`../PLAN.md`](../PLAN.md) first — the interface there is frozen.

## Context

Vision guide (Responses API):
https://developers.openai.com/api/docs/guides/images-vision?api-mode=responses

```js
const response = await openai.responses.create({
  model: "...",
  input: [{
    role: "user",
    content: [
      { type: "input_text", text: "what's in this image?" },
      { type: "input_image", image_url: `data:image/jpeg;base64,${b64}`, detail: "high" },
    ],
  }],
});
```

Supported types: PNG, JPEG, WEBP, non-animated GIF.

## Tasks

1. `npm install openai`. Verify the installed SDK's Responses API types in
   `node_modules/openai` — in particular how Structured Outputs are declared
   (`text: { format: { type: "json_schema", name, schema, strict: true } }`) and
   whether a helper like `responses.parse` + `zodTextFormat` exists. Prefer a
   plain JSON schema (no new `zod` dependency) unless zod is already present.
2. `image-input.ts`: implement `parseImageDataUrl`, `ALLOWED_IMAGE_TYPES`,
   `MAX_IMAGE_BYTES` per the plan. Compute decoded size from the base64 length
   without allocating a Buffer of the whole image if easy; correctness first.
3. `prompt.ts`: system instructions + JSON schema for `ImageDescription`.
   Instructions must:
   - describe only what is visible; never state or imply whether the market's
     event happened / which side wins;
   - use the question only to decide which details matter (e.g. scores, counts,
     states of objects, clocks, text);
   - never identify people by name or infer identity, age, ethnicity etc.;
     describe people by visible clothing/position/actions;
   - transcribe legible text verbatim into `visibleText`;
   - fill `limitations` with anything ambiguous, occluded, off-frame, or signs
     it is a photo of a screen/printout or looks edited;
   - set `imageQuality` honestly (`unusable` for black/blurred/irrelevant).
   Treat the question/context strings as untrusted user text — put them in a
   delimited block and tell the model not to follow instructions inside them.
4. `describe.ts` (`import "server-only"`, matching other server libs — check
   how `src/lib/chain/wallet.ts` or similar does it):
   - lazily construct one `OpenAI` client from `OPENAI_API_KEY`, `timeout: 60_000`;
   - model from `OPENAI_VISION_MODEL`, default `gpt-5.6-terra`;
   - validate input with `parseImageDataUrl` before any network call;
   - call the Responses API with the image + strict schema; handle refusals
     (`refused`), unparsable / schema-violating output (`bad_output`), and
     SDK/API errors (`upstream`, preserve the message but never the key);
   - trim strings, drop empty array entries;
   - missing key: dev → stub result (`stub: true`, `model: "stub"`, one-time
     `console.warn`); production → `DescribeError("not_configured")`;
   - `formatDescription`: stable plain-text layout, e.g.
     `Summary: …\nObservations:\n- …\nVisible text:\n- …\nLimitations:\n- …\nImage quality: clear`
     (omit empty sections).
5. `.env.example`: add `OPENAI_API_KEY=` and commented
   `# OPENAI_VISION_MODEL=gpt-5.6-terra`, with a one-line comment, matching the
   file's existing style.
6. `package.json`: add script
   `"describe": "node --conditions=react-server --import tsx scripts/describe-image.ts"`
   (R2 writes that file; mirror the existing `fund`/`smoke` scripts — the
   `react-server` condition is what lets `server-only` import outside Next).

## Non-negotiables

- Exact exported names/types from the plan.
- No API call on invalid input.
- Stub never used when `NODE_ENV === "production"`.
- The key is never logged or included in error messages.

## Definition of done

- `npx tsc --noEmit` and `npm run lint` pass (report output; note pre-existing
  failures separately).
- A quick throwaway check (in your scratch dir, not committed) that
  `parseImageDataUrl` accepts a small valid JPEG data URL and rejects: non-data
  URL, `image/svg+xml`, bad base64, oversize.
- If `OPENAI_API_KEY` is available in the environment/`.env.local`, one live
  call against a real image succeeds; otherwise say it was not run.

## Report back

SDK version, how Structured Outputs was declared, the final prompt text, and
the live-call result (or that it wasn't run).
