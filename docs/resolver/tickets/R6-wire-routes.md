# R6 — Wire validate / policy / settle into routes

**Depends on:** R4, R5 · **Blocks:** —
**Owns:** `src/lib/integrations/resolver.ts`,
`src/app/api/markets/[marketId]/resolve/route.ts`,
`src/app/api/markets/[marketId]/resolve/confirm/route.ts`,
`src/app/api/markets/[marketId]/settle/route.ts` (new),
`src/app/api/markets/[marketId]/route.ts`,
`src/app/api/markets/[marketId]/trade/route.ts`,
`src/app/api/groups/[groupId]/route.ts`,
`src/app/api/groups/[groupId]/markets/route.ts` (GET handler only),
`src/lib/markets.ts`

Read [`../PLAN-2-validate-settle.md`](../PLAN-2-validate-settle.md) — especially
the HTTP API table, which R7's UI is being built against in parallel —
`src/lib/resolver/{types,policy,settle,validate,errors,describe}.ts`, and the
Next 16 docs for route handlers and `after`
(`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`).

## Tasks

1. **`resolver.ts`**: replace the keyword `decide` stub. `resolveFromImage`
   runs describe → sanitize (as today) → `validateDescription` →
   `decideResolution`, returning `{ description (sanitized text), details,
   describeModel, describeStub, validation, decision }`. Delete `decide`.
   Update the header comment.
2. **Resolve route** (`POST`): per the API table. Build a `ResolutionRecord`
   (`status: "pending"` + `source: "ai"` + `outcome` for `auto`; else
   `needs_owner`), persist it with the photo fields (`resolutionImageUrl`,
   `resolutionNote`, `aiDescription`, `aiModel`; keep `aiPrediction`/
   `aiConfidence` populated from the verdict for backwards compatibility —
   `aiPrediction` only when verdict is yes/no). Then, if `isSettleDue`, await
   `settleMarket`. Catch `ResolverError` → `fail(message, status)`; nothing
   persisted on failure. Keep the World `matchFace` call as is.
   Enforce the replacement rule (plan decision 6).
3. **Resolve route** (`DELETE`): owner clears record + photo/AI fields.
4. **Confirm route**: owner sets `outcome`, `source: "owner"`, `status:
   "pending"`, then settles if due (else `waiting`). Remove the inline
   close/resolve code in favour of `settleMarket`. Requires a record.
5. **Settle route** (new, `POST`): owner only; 409 before close time or with no
   `pending`/`failed` record; await `settleMarket`.
6. **Lazy settle**: in market `GET`, group `GET`, group markets `GET`, for each
   market where `isSettleDue`, schedule `after(() => settleMarket(id))`. Do not
   await in the request.
7. **Trade pause**: trade route returns 409 while `meta.resolution` exists.
8. **Redaction** in `toMarketView` (`markets.ts`): map `Market.resolution` to
   `MarketView.resolution`. Viewer is owner ⇔
   `db.getUserByWallet(viewerWallet)?.id === groupOwnerId`. If the viewer isn't
   the owner and chain status isn't `resolved`: redacted resolution, and omit
   `resolutionImageUrl`, `resolutionNote`, `aiDescription`, `aiModel`,
   `aiPrediction`, `aiConfidence`. Check every `toMarketView` caller passes
   `viewerWallet` (confirm routes under `groups/.../markets/confirm` too — if a
   caller outside your scope doesn't, report it). `...market` spread must not
   leak the raw record.
9. Response bodies must never include an unredacted record for a non-owner
   (e.g. the submitter's own resolve response).

## Verification

- `npx tsc --noEmit`, `npx eslint` on owned files.
- A scratch script exercising `toMarketView` redaction (owner vs member vs
  resolved market) and `resolveFromImage` live once (key is in `.env.local`).
- Start `npm run dev:web` **on a different port** (`-- -p 3100`) — the user
  has a dev server on 3000 — and hit routes that don't need a session to
  confirm they compile (401 is fine). If you can drive an authenticated flow,
  do; otherwise say so. Stop your server afterwards.

## Report back

Per-file summary, redaction proof output, any caller outside scope that needs
changing, and whether anything touched devnet.
