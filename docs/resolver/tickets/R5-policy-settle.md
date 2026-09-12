# R5 — Auto-resolve policy + settlement service

**Depends on:** `src/lib/resolver/types.ts` · **Blocks:** R6
**Owns:** `src/lib/resolver/policy.ts` (new), `src/lib/resolver/settle.ts` (new)

Read [`../PLAN-2-validate-settle.md`](../PLAN-2-validate-settle.md) (decisions
1–3, 9 and the lifecycle), `src/lib/resolver/types.ts`, and:
`src/lib/chain/{actions,wallet,projection,program}.ts`,
`src/lib/store.ts`, `src/types/index.ts` (`Market.resolution`),
`src/app/api/markets/[marketId]/resolve/confirm/route.ts` (current on-chain
settle code), `src/app/api/groups/[groupId]/markets/route.ts` (`onChainMessage`),
and the program's `close_market.rs` / `resolve_market.rs` / `errors.rs` under
`contracts/programs/greekbet/src/`.

## Tasks

### `policy.ts` (pure, no I/O, not server-only)

```ts
export const DEFAULT_AUTO_CONFIDENCE = 0.85;
/** RESOLVER_AUTO_CONFIDENCE, validated to (0,1]; falls back to the default. */
export function autoConfidenceThreshold(): number;
export function decideResolution(input: {
  description: ImageDescription;
  describeStub: boolean;
  validation: ValidationResult;
  threshold?: number;
}): PolicyDecision;
```

Rules, checked in this order, first failure wins (`needs_owner` + reason):
stub (either stage) → verdict `neither` → `imageQuality !== "clear"` →
`redFlags` non-empty → `confidence < threshold`. Otherwise `auto` with
`outcome = verdict`. Reasons are short, user-facing sentences.

### `settle.ts` (`server-only`)

```ts
export function isSettleDue(market: Market, chain: ChainMarket | undefined, now?: number): boolean;
export function settleMarket(marketId: string): Promise<SettleResult>;
```

- **Due** = record status `pending`, or `failed`, or `settling` with
  `updatedAt` older than 2 minutes; record has `outcome`; chain market is
  indexed; chain status not already `resolved`... except see idempotency below;
  and `closeTime * 1000 <= now`.
- `settleMarket`:
  1. Per-market in-process lock (`Map<string, Promise<SettleResult>>`):
     concurrent calls share the in-flight promise.
  2. Load market + record. No record / `needs_owner` / no outcome → `skipped`.
     Already `settled` → `settled` with stored signature.
  3. If chain status is `resolved`: mark record `settled` (signature `null`
     unless known). If the chain's winning outcome differs from the record,
     record it in `error` and `console.error` loudly — the chain is truth.
  4. If close time not reached → `waiting`.
  5. Mark `settling`, `attempts += 1`, `updatedAt`.
  6. If chain status `open`, `closeMarket` (fee payer). Treat the program's
     "market not open" error as already closed and continue. **Don't wait for
     the projection** to show `closed` — it lags; go straight to resolve.
  7. `resolveMarket` with `resolverKeypair()` + `feePayerKeypair()`. Treat
     "already resolved" as success (step-3 semantics).
  8. Success → `settled`, `settledAt`, signatures, clear `error`; call
     `projection()` to nudge the read model. Failure → `failed` with a readable
     message (reuse `onChainMessage` if it is importable without a cycle; if
     not, write a small equivalent and report it).
  9. Never throw — every path returns a `SettleResult`.
- Identify program errors by Anchor error code/name, not by message substring
  alone. Find how errors surface from `sendAndConfirm` in `program.ts`.
- Make it testable: `settleMarket` delegates to an exported
  `createSettler(deps)` (store get/update, getChainMarket, closeMarket,
  resolveMarket, keypairs, now) so tests inject fakes.

## Verification

- `npx tsc --noEmit`, `npx eslint` on owned files.
- Scratch-dir test script (`node --conditions=react-server --import tsx`):
  - policy: a table of cases covering every rule and the threshold boundary
    (exactly 0.85 → auto);
  - settler with fakes: not due (before close) → waiting; open → close then
    resolve; close says not-open → continues to resolve; resolve says already
    resolved → settled; resolve throws → failed with message, record updated;
    chain already resolved with a different outcome → settled + error logged;
    two concurrent calls → one close + one resolve; stale `settling` (>2 min)
    retried, fresh `settling` skipped; `needs_owner` skipped.
- No devnet transactions required; if you do run one, say so.

## Report back

How program errors are detected, the lock/idempotency design, test output, and
any change needed outside scope.
