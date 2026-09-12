# R3 — Wire describe into the resolve route

**Depends on:** R1 · **Blocks:** stage 2 (validate)
**Owns:** `src/lib/integrations/resolver.ts`,
`src/app/api/markets/[marketId]/resolve/route.ts`, `src/types/index.ts`

Read [`../PLAN.md`](../PLAN.md) first. Read the Next 16 route handler docs in
`node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
and `01-app/03-api-reference/03-file-conventions/route.md` before editing the
route.

## Tasks

1. `resolver.ts`:
   - Delete the stub `describeImage`; call the real one from
     `@/lib/resolver/describe`.
   - Change `resolveFromImage` to take
     `{ question, context?, imageDataUrl }` (update the single caller).
   - Run `sanitize` over `formatDescription(description)`; that text is what
     `decide` receives and what is returned as `Resolution.description`.
   - Extend `Resolution` with `details: ImageDescription`, `model: string`,
     `stub: boolean`. Keep `outcome`, `description`, `confidence`.
   - Leave `decide` as the existing stub (stage 2 replaces it), but if
     `details.imageQuality === "unusable"` return confidence `0` — no point
     pretending the heuristic learned anything.
   - Update the header comment: describe is real, decide is still a stub.
2. `types/index.ts`: add to `Market`
   `aiDescription?: ImageDescription` (import the type — it is JSON-serializable)
   and `aiModel?: string`, with short doc comments in the file's style.
3. `route.ts`:
   - Pass `meta.title` as question and `meta.description` as context.
   - Wrap the resolver call: `DescribeError` → `fail(err.message, err.status)`;
     anything else → `fail("Could not analyze the photo", 502)` and
     `console.error` the underlying error.
   - Do **not** persist anything to the market if describe fails (currently the
     `updateMarket` call would run after — keep it after the call succeeds).
   - Persist `aiDescription` and `aiModel` alongside the existing fields; add
     `description` details, `model`, and `stub` to the `prediction` in the
     response body.
   - Consider running `matchFace` and the resolver concurrently with
     `Promise.all`; do it if it stays simple.
4. Check `src/lib/api.ts` for the client type of `resolveMarket`'s response and
   whether it would break — you don't own it; if it needs a change, report it.

## Non-negotiables

- The route still decides nothing on chain.
- No market mutation on failure.
- Response/`MarketView` stays backwards compatible for the resolve page
  (`resolutionNote`, `aiPrediction`, `aiConfidence` still populated).

## Definition of done

- `npx tsc --noEmit` and `npm run lint` pass.
- Start the dev server (`npm run dev:web`) and POST to the route if you can
  obtain a session; if auth makes that impractical, say so and instead
  exercise `resolveFromImage` directly via a throwaway tsx script in your
  scratch dir (`node --conditions=react-server --import tsx`), in stub mode
  and live if a key is present. Report which was done.
- Invalid `imageDataUrl` (e.g. `"data:text/plain;base64,aGk="`) yields a 400
  from the route (or `DescribeError invalid_image` from the function).

## Report back

Diff summary, any needed change in files you don't own, and verification output.
