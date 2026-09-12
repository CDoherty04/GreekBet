# R7 — Resolve + market UI for the new lifecycle

**Depends on:** `src/lib/resolver/types.ts`, the HTTP API table in the plan
**Blocks:** —
**Owns:** `src/app/markets/[marketId]/resolve/page.tsx`,
`src/app/markets/[marketId]/page.tsx`, `src/components/MarketCard.tsx`,
`src/lib/api.ts`

Read [`../PLAN-2-validate-settle.md`](../PLAN-2-validate-settle.md) (decisions
4–6, lifecycle, **HTTP API table**), `src/lib/resolver/types.ts`,
`src/types/index.ts` (`MarketView.resolution`), and the three owned files plus
`src/components/ui/*` for existing styling. The routes are being built in
parallel by R6 against the same table — code to the table, not to the current
route implementations.

## Tasks

1. **`api.ts`**: update `resolveMarket` → `{ market, settle }`; add
   `clearResolution(marketId)` (DELETE), `settleMarket(marketId)`; update
   `confirmResolution` → `{ market, settle }`. Import `SettleResult` from
   `@/types` (it's re-exported there) or `@/lib/resolver/types` via
   `import type`.
2. **Resolve page** — drive entirely off `market.resolution` and `status`:
   - **No record:** today's capture + submit flow.
   - **Redacted (non-owner):** "Resolution photo submitted" + status copy:
     pending → "Settles automatically when the event closes"; needs_owner →
     "Waiting for the owner to decide"; settling → "Settling on chain…";
     failed → "Settlement is retrying". No photo, no verdict.
   - **Owner, `pending`:** photo, verdict + confidence bar (existing styling),
     reasoning, evidence list, source (AI / you), countdown to close (reuse
     `Countdown`), and a **Settle now** button enabled only after close time.
     "Retake photo" → clearResolution.
   - **Owner, `needs_owner`:** photo, AI verdict (or "Couldn't decide"),
     `policyReason`, reasoning, red flags, YES / NO buttons (confirm), retake.
     If `stub`, say the AI isn't configured.
   - **Owner, `failed`:** error message + Settle now (retry).
   - **`settling`:** spinner copy; poll `getMarket` every ~3 s until status
     changes.
   - **Resolved (everyone):** existing `SettledView`, plus AI reasoning when
     the record is visible.
   - Show `settle` results from mutations inline (e.g. `waiting` → "Locked in —
     settles at close").
3. **Market page**: where it links to resolve / shows AI info (~line 528) and
   the trade panel: when `market.resolution` exists and status isn't resolved,
   show a "Resolution submitted — trading paused" notice and disable trade
   inputs (the server also refuses with 409; surface that message if it
   happens).
4. **MarketCard**: a small status chip for `pending` / `needs_owner` /
   `settling` / `failed` (e.g. "Settling at close", "Needs owner").
5. Keep the mobile layout and existing components; no new dependencies.

## Verification

- `npx tsc --noEmit`, `npx eslint` on owned files.
- Until R6 lands the routes won't return the new shapes, so verify rendering
  with a temporary fixture: in a scratch copy or behind a clearly-marked
  dev-only toggle you remove before finishing, render each state with mocked
  `MarketView`s and take screenshots if you can drive a browser; otherwise
  describe what you checked. Do not leave fixtures in owned files.
- The user's dev server is on port 3000; if you need one, use `-p 3100` and
  stop it afterwards.

## Report back

States implemented, how you verified them, and any API-shape assumptions that
R6 needs to honour.
