# AI Resolver — Plan 2: Validate + Settle

Builds on [`PLAN.md`](./PLAN.md) (stage 1, describe — done). This phase adds:

2. **Validate** — a text-only OpenAI call reads the stage-1 description and
   returns `yes | no | neither` + confidence + reasoning.
3. **Settle** — a policy decides whether the verdict can resolve the market
   automatically; if so the server closes and resolves it on chain once close
   time has passed.

Frozen types live in `src/lib/resolver/types.ts` (already written — read it).

## Decisions (made with the user)

1. **Auto-resolve above a threshold.** A verdict resolves on chain with no human
   step only if *all* hold: verdict is `yes`/`no`; confidence ≥
   `RESOLVER_AUTO_CONFIDENCE` (default `0.85`); `imageQuality === "clear"`;
   `redFlags` is empty; neither stage was a stub. Anything else →
   `needs_owner`: the owner picks YES/NO with the existing confirm buttons.
2. **No contract change.** The program can only close after `close_time` and
   only resolve a `Closed` market. A verdict (AI or owner) from before close is
   stored as `pending` and settles at close.
3. **Settling triggers:**
   - immediately in the resolve / confirm routes if close time has passed;
   - lazily, via Next's `after()`, when a market or group feed is loaded and a
     `pending`/`failed` record is due;
   - manually: owner-only `POST /api/markets/[id]/settle` ("Settle now"),
     which only works once close time has passed.
4. **Pending verdicts are hidden.** Until the market is resolved on chain,
   non-owners see only that a photo was submitted and its status — not the
   photo, description, verdict or confidence. The photo reveals the answer as
   much as the verdict does, so both are hidden.
5. **App trading pauses while a resolution record exists** (any status except
   none). Hiding the verdict does not stop the submitter, who has seen the
   photo, from trading on it. This is an app-level pause (the trade route
   refuses to build transactions); the program itself still allows trades until
   close. The owner can clear the record (retake) to resume trading.
6. **Replacing a photo:** once a record exists, only the owner may submit a new
   photo or clear it; members get 409. Stops a member re-rolling an unfavourable
   verdict. Records in `settling`/`settled` cannot be replaced.
7. **Validator sees only the description, not the image.** That keeps the two
   stages independent and makes the verdict auditable against stored text.
   The description is untrusted data (it transcribes signs/screens from the
   photo) — the prompt must not follow instructions found in it.
8. **Named people.** Face matching is deferred, so the validator cannot confirm
   *who* "Person 1" is. When the question names a person, the validator notes
   identity is unverified in `reasoning` and lowers confidence; it adds a red
   flag only if the description is ambiguous about which person the question
   refers to (e.g. several people could fit).
9. **Idempotent, locked settlement.** One in-process lock per market; the
   chain is the source of truth (`MarketAlreadyResolved` / already-closed are
   success paths, not failures). A `settling` record older than 2 minutes is
   treated as crashed and retried.
10. **Models:** validator `OPENAI_VALIDATOR_MODEL`, default `gpt-5.6-terra`,
    `store: false`, strict Structured Outputs — same conventions as describe.

## Status lifecycle

```
submit photo ─► describe ─► validate ─► policy
                                          │
                  ┌───────────────────────┴──────────────┐
             auto (yes/no)                          needs_owner
                  │                                      │ owner taps YES/NO
                  ▼                                      ▼
               pending ◄──────────────────────────── pending (source: owner)
                  │ close time passed + trigger
                  ▼
               settling ──► settled   (resolved on chain)
                  │
                  └──► failed ──(next trigger / Settle now)──► settling
```

## HTTP API (frozen — R6 implements, R7 consumes)

All routes require sign-in and group membership (404 otherwise), as today.
`market` is always a `MarketView` redacted for the viewer.

| Route | Who | Body | Response | Notes |
|---|---|---|---|---|
| `POST /api/markets/[id]/resolve` | member (owner if a record exists) | `{ imageDataUrl }` | `{ market, settle: SettleResult \| null }` | describe → validate → policy → store record; settle now if due. 409 if a record exists and caller isn't owner, or record is `settling`/`settled`. Resolver errors map to their status. |
| `DELETE /api/markets/[id]/resolve` | owner | — | `{ market }` | Clears the record + photo fields. 409 if `settling`/`settled`. |
| `POST /api/markets/[id]/resolve/confirm` | owner | `{ outcome }` | `{ market, settle: SettleResult }` | Sets record `pending`, `source: "owner"`. Settles now if due, else `waiting`. Requires a photo record. |
| `POST /api/markets/[id]/settle` | owner | — | `{ market, settle: SettleResult }` | Awaits settlement. 409 before close time or if no `pending`/`failed` record. |
| `POST /api/markets/[id]/trade` | member | unchanged | unchanged | New: 409 `"A resolution photo was submitted — trading is paused"` while a record exists. |
| `GET` market / group / group markets | member | — | unchanged shape | Schedules `after(() => settleMarket(id))` for due markets. |

## Tickets

| ID | Title | Depends on | Owns |
|---|---|---|---|
| [R4](./tickets/R4-validator.md) | Validator + shared OpenAI client | types.ts | `src/lib/resolver/{openai,errors,validate,validate-prompt,describe,image-input}.ts`, `scripts/describe-image.ts`, `.env.example` |
| [R5](./tickets/R5-policy-settle.md) | Auto-resolve policy + settlement service | types.ts | `src/lib/resolver/{policy,settle}.ts` |
| [R7](./tickets/R7-resolve-ui.md) | Resolve + market UI for the new lifecycle | types.ts, API table | `src/app/markets/[marketId]/resolve/page.tsx`, `src/app/markets/[marketId]/page.tsx`, `src/components/MarketCard.tsx`, `src/lib/api.ts` |
| [R6](./tickets/R6-wire-routes.md) | Wire validate/policy/settle into routes, redaction, trade pause | R4, R5 | see ticket |

```
Wave 1   R4  R5  R7   (parallel)
Wave 2   R6
```

## Rules for every ticket

Same as PLAN.md: stay in file scope (report needed changes elsewhere), read the
Next 16 docs in `node_modules/next/dist/docs/` before route code, don't change
`src/lib/resolver/types.ts` (report if it's wrong), report `npx tsc --noEmit`
and `npx eslint <your files>` (whole-repo lint has ~19.8k pre-existing
problems), never print keys, don't commit.

## Out of scope

Contract changes / early resolution; member face matching; majority voting;
disputes/appeals after settlement (settlement is irreversible on chain).
