/**
 * Settlement service (resolver stage 3, chain half). **Server-only.**
 *
 * Takes a market whose `resolution` record has a chosen outcome (AI or owner)
 * and writes it on chain once close time has passed: `close_market` (fee
 * payer, permissionless) then `resolve_market` (resolver key).
 *
 * ## Idempotency
 *
 * The chain is the source of truth. A market that is already closed or already
 * resolved is a success path, not a failure: `MarketNotOpen` from close means
 * someone else cranked it, and `MarketAlreadyResolved` from resolve means the
 * write already landed. Program errors are identified by Anchor error code
 * (read from the bundled IDL), never by message text alone.
 *
 * ## Locking
 *
 * One in-process promise per market: concurrent calls share the in-flight
 * attempt. Across processes / crashes the `settling` status is the lock; one
 * older than {@link STALE_SETTLING_MS} is treated as crashed and retried.
 *
 * See `docs/resolver/PLAN-2-validate-settle.md`, decisions 2, 3 and 9.
 */

import "server-only";

import { PublicKey, type Keypair } from "@solana/web3.js";

import { db } from "@/lib/store";
import { closeMarket, resolveMarket } from "@/lib/chain/actions";
import {
  getChainMarket,
  projection,
  type ChainMarket,
} from "@/lib/chain/projection";
import { feePayerKeypair, resolverKeypair } from "@/lib/chain/wallet";
import idlJson from "@/lib/chain/greekbet.json";
import type { Market } from "@/types";

import type { ResolutionRecord, SettleResult } from "./types";

/** A `settling` record older than this is assumed crashed and retried. */
export const STALE_SETTLING_MS = 2 * 60 * 1000;

type Outcome = "yes" | "no";

/* ------------------------------------------------------------------ */
/* Program error detection                                             */
/* ------------------------------------------------------------------ */

interface IdlError {
  code: number;
  name: string;
  msg?: string;
}

const PROGRAM_ERRORS: ReadonlyMap<number, IdlError> = new Map(
  ((idlJson as { errors?: IdlError[] }).errors ?? []).map((e) => [e.code, e]),
);
const PROGRAM_ERROR_BY_NAME: ReadonlyMap<string, IdlError> = new Map(
  [...PROGRAM_ERRORS.values()].map((e) => [e.name, e]),
);

function codeOf(name: string): number {
  const entry = PROGRAM_ERROR_BY_NAME.get(name);
  if (!entry) throw new Error(`IDL has no error named ${name}`);
  return entry.code;
}

/** Codes the settler branches on, resolved from the IDL at load. */
export const ERR = {
  MarketNotOpen: codeOf("MarketNotOpen"), // 6000
  MarketNotClosed: codeOf("MarketNotClosed"), // 6001
  MarketAlreadyResolved: codeOf("MarketAlreadyResolved"), // 6003
  CloseTimeNotReached: codeOf("CloseTimeNotReached"), // 6004
  Unauthorized: codeOf("Unauthorized"), // 6006
} as const;

/**
 * The GreekBet program error in `err`, if any.
 *
 * `sendAndConfirm` rethrows web3.js's `SendTransactionError` from preflight.
 * Its message carries `custom program error: 0x1773` and its `logs` carry
 * Anchor's `Error Code: MarketAlreadyResolved. Error Number: 6003.` A decoded
 * `AnchorError` (`err.error.errorCode`) and the JSON `{"Custom":6003}`
 * instruction-error form are handled too. Only codes present in the IDL
 * count, so another program's small custom codes (e.g. token `0x1`) don't
 * masquerade as ours.
 */
export function programError(err: unknown): IdlError | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    message?: unknown;
    logs?: unknown;
    transactionLogs?: unknown;
    transactionError?: { logs?: unknown };
    error?: { errorCode?: { number?: unknown; code?: unknown } };
  };

  const known = (code: number) => PROGRAM_ERRORS.get(code) ?? null;

  const direct = e.error?.errorCode;
  if (typeof direct?.number === "number" && known(direct.number)) {
    return known(direct.number);
  }
  if (typeof direct?.code === "string" && PROGRAM_ERROR_BY_NAME.has(direct.code)) {
    return PROGRAM_ERROR_BY_NAME.get(direct.code)!;
  }

  const logs = [e.logs, e.transactionLogs, e.transactionError?.logs].flatMap(
    (l) => (Array.isArray(l) ? l.map(String) : []),
  );
  const text = [typeof e.message === "string" ? e.message : "", ...logs].join(
    "\n",
  );

  const number = /Error Number: (\d+)/.exec(text);
  if (number && known(Number(number[1]))) return known(Number(number[1]));

  const named = /Error Code: (\w+)/.exec(text);
  if (named && PROGRAM_ERROR_BY_NAME.has(named[1]!)) {
    return PROGRAM_ERROR_BY_NAME.get(named[1]!)!;
  }

  for (const m of text.matchAll(/custom program error: (0x[0-9a-fA-F]+|\d+)/g)) {
    const code = m[1]!.startsWith("0x") ? parseInt(m[1]!, 16) : Number(m[1]);
    if (known(code)) return known(code);
  }

  for (const m of text.matchAll(/"Custom"\s*:\s*(\d+)/g)) {
    if (known(Number(m[1]))) return known(Number(m[1]));
  }

  return null;
}

/**
 * A readable settle failure.
 *
 * Deliberately not `onChainMessage` from the group-markets route: importing a
 * route module into a lib would create a cycle once routes import this file,
 * and its `"0x1"` substring check misreads every `custom program error: 0x17xx`
 * as "Not enough USDC".
 */
export function settleErrorMessage(err: unknown): string {
  const program = programError(err);
  if (program) {
    switch (program.name) {
      case "Unauthorized":
        return "This market's resolver isn't the server's resolver key, so it can't be settled here.";
      case "MarketNotClosed":
        return "The market hasn't closed on chain yet.";
      case "CloseTimeNotReached":
        return "The close time hasn't been reached on chain yet.";
      default:
        return `On-chain error: ${program.msg ?? program.name}.`;
    }
  }

  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes("Attempt to debit an account but found no record") ||
    msg.includes("insufficient funds for fee") ||
    msg.includes("insufficient lamports")
  ) {
    return "The server's fee payer has no devnet SOL.";
  }
  if (
    (err instanceof Error && err.name === "TransactionExpiredBlockheightExceededError") ||
    msg.includes("block height exceeded")
  ) {
    return "The transaction expired before it confirmed.";
  }
  const first = msg.split("\n")[0]?.trim();
  if (!first) return "On-chain transaction failed.";
  return first.length > 200 ? `${first.slice(0, 197)}...` : first;
}

/* ------------------------------------------------------------------ */
/* Due check                                                           */
/* ------------------------------------------------------------------ */

function isRetryable(record: ResolutionRecord, now: number): boolean {
  return (
    record.status === "pending" ||
    record.status === "failed" ||
    (record.status === "settling" && now - record.updatedAt >= STALE_SETTLING_MS)
  );
}

/**
 * Whether a trigger should call {@link settleMarket} for this market.
 *
 * Due = record is `pending`, `failed`, or stale `settling`; it has an outcome;
 * the chain market is indexed; and close time has passed. A market already
 * `resolved` on chain is due regardless of close time — settling it only
 * reconciles the record and sends nothing.
 */
export function isSettleDue(
  market: Market,
  chain: ChainMarket | undefined,
  now: number = Date.now(),
): boolean {
  const record = market.resolution;
  if (!record?.outcome || !isRetryable(record, now)) return false;
  if (!chain) return false;
  if (chain.status === "resolved") return true;
  return chain.closeTime * 1000 <= now;
}

/* ------------------------------------------------------------------ */
/* Settler                                                             */
/* ------------------------------------------------------------------ */

export interface SettlerDeps {
  getMarket(address: string): Market | undefined;
  updateMarket(address: string, patch: Partial<Market>): Market | undefined;
  getChainMarket(address: string): ChainMarket | undefined;
  closeMarket(input: { payer: Keypair; market: PublicKey }): Promise<string>;
  resolveMarket(input: {
    resolver: Keypair;
    payer?: Keypair;
    market: PublicKey;
    outcome: Outcome;
  }): Promise<string>;
  resolverKeypair(): Keypair;
  feePayerKeypair(): Keypair;
  /** Re-read the indexer projection. */
  refreshProjection(): void;
  now(): number;
  /** Defaults to `console`. */
  log?: Pick<Console, "error" | "warn">;
  /** In-flight attempts; defaults to a fresh map. */
  locks?: Map<string, Promise<SettleResult>>;
}

export interface Settler {
  settleMarket(marketId: string): Promise<SettleResult>;
}

export function createSettler(deps: SettlerDeps): Settler {
  const locks = deps.locks ?? new Map<string, Promise<SettleResult>>();
  const log = deps.log ?? console;

  /** Merge into the *current* record; no-op if it was cleared meanwhile. */
  function patchRecord(
    marketId: string,
    patch: Partial<ResolutionRecord>,
  ): ResolutionRecord | undefined {
    const current = deps.getMarket(marketId)?.resolution;
    if (!current) return undefined;
    const next: ResolutionRecord = { ...current, ...patch };
    // `undefined` means "clear" — drop it rather than persisting the key.
    for (const key of Object.keys(next) as (keyof ResolutionRecord)[]) {
      if (next[key] === undefined) delete next[key];
    }
    deps.updateMarket(marketId, { resolution: next });
    return next;
  }

  /**
   * Mark `settled` because the chain says it is resolved. If the chain's
   * outcome differs from the record, the chain wins: say so loudly.
   */
  function settledFromChain(
    marketId: string,
    record: ResolutionRecord,
    chainOutcome: Outcome | undefined,
    extra: Partial<ResolutionRecord> = {},
  ): SettleResult {
    const now = deps.now();
    const recorded = record.outcome!;
    const outcome = chainOutcome ?? recorded;
    let error: string | undefined;
    if (chainOutcome && chainOutcome !== recorded) {
      error = `Resolved on chain as ${chainOutcome.toUpperCase()}, but this record chose ${recorded.toUpperCase()}. The on-chain outcome is final.`;
      log.error(
        `[settle] OUTCOME MISMATCH for market ${marketId}: chain=${chainOutcome} record=${recorded}`,
      );
    } else if (!chainOutcome) {
      log.warn(
        `[settle] market ${marketId} is already resolved on chain; outcome not yet visible to the indexer, assuming ${recorded}`,
      );
    }
    patchRecord(marketId, {
      ...extra,
      status: "settled",
      settledAt: record.settledAt ?? now,
      updatedAt: now,
      error,
    });
    return {
      state: "settled",
      outcome,
      signature: extra.resolveSignature ?? record.resolveSignature ?? null,
    };
  }

  async function run(marketId: string): Promise<SettleResult> {
    const meta = deps.getMarket(marketId);
    if (!meta) return { state: "skipped", reason: "Market not found." };
    const record = meta.resolution;
    if (!record) {
      return { state: "skipped", reason: "No resolution has been submitted." };
    }

    if (record.status === "settled" && record.outcome) {
      return {
        state: "settled",
        outcome: record.outcome,
        signature: record.resolveSignature ?? null,
      };
    }
    if (record.status === "needs_owner" || !record.outcome) {
      return {
        state: "skipped",
        reason: "Waiting for the owner to choose YES or NO.",
      };
    }

    const now = deps.now();
    if (!isRetryable(record, now)) {
      // Only fresh `settling` reaches here: another process (or a request
      // that hasn't crashed) owns it.
      return { state: "skipped", reason: "Settlement is already in progress." };
    }

    const chain = deps.getChainMarket(marketId);
    if (!chain) {
      return { state: "skipped", reason: "Market is not indexed yet." };
    }

    // Step 3: already resolved on chain — reconcile, send nothing.
    if (chain.status === "resolved") {
      return settledFromChain(marketId, record, chain.winningOutcome);
    }

    // Step 4.
    const closesAt = chain.closeTime * 1000;
    if (closesAt > now) return { state: "waiting", closesAt };

    // Step 5.
    const previousStatus = record.status;
    patchRecord(marketId, {
      status: "settling",
      attempts: (record.attempts ?? 0) + 1,
      updatedAt: now,
    });

    const outcome = record.outcome;
    let closeSignature: string | undefined;
    try {
      const market = new PublicKey(marketId);
      const payer = deps.feePayerKeypair();
      const resolver = deps.resolverKeypair();

      // Step 6. Don't wait for the projection to show `closed` — it lags.
      if (chain.status === "open") {
        try {
          closeSignature = await deps.closeMarket({ payer, market });
          patchRecord(marketId, { closeSignature, updatedAt: deps.now() });
        } catch (err) {
          const code = programError(err)?.code;
          if (code === ERR.CloseTimeNotReached) {
            // Wall clock is past close but the cluster clock isn't yet. Not a
            // failure: put the record back and let the next trigger retry.
            patchRecord(marketId, {
              status: previousStatus,
              updatedAt: deps.now(),
            });
            return { state: "waiting", closesAt };
          }
          if (code !== ERR.MarketNotOpen) throw err;
          // MarketNotOpen: someone else closed (or resolved) it. Continue.
        }
      }

      // Step 7.
      let resolveSignature: string;
      try {
        resolveSignature = await deps.resolveMarket({
          resolver,
          payer,
          market,
          outcome,
        });
      } catch (err) {
        if (programError(err)?.code !== ERR.MarketAlreadyResolved) throw err;
        deps.refreshProjection();
        const latest = deps.getChainMarket(marketId);
        return settledFromChain(
          marketId,
          record,
          latest?.status === "resolved" ? latest.winningOutcome : undefined,
          closeSignature ? { closeSignature } : {},
        );
      }

      // Step 8, success.
      const settledAt = deps.now();
      patchRecord(marketId, {
        status: "settled",
        settledAt,
        updatedAt: settledAt,
        resolveSignature,
        ...(closeSignature ? { closeSignature } : {}),
        error: undefined,
      });
      deps.refreshProjection();
      return { state: "settled", outcome, signature: resolveSignature };
    } catch (err) {
      // Step 8, failure.
      const error = settleErrorMessage(err);
      log.error(`[settle] market ${marketId} failed: ${error}`, err);
      patchRecord(marketId, { status: "failed", error, updatedAt: deps.now() });
      return { state: "failed", error };
    }
  }

  function settleMarket(marketId: string): Promise<SettleResult> {
    const inflight = locks.get(marketId);
    if (inflight) return inflight;

    // `run` is invoked and its promise registered in the same tick, so a
    // second caller can never slip in between.
    const attempt = run(marketId)
      .catch((err): SettleResult => {
        // Step 9: never throw. Reaching here means a dependency (store,
        // projection) threw outside the guarded chain section.
        log.error(`[settle] market ${marketId} crashed`, err);
        return { state: "failed", error: settleErrorMessage(err) };
      })
      .finally(() => {
        if (locks.get(marketId) === attempt) locks.delete(marketId);
      });
    locks.set(marketId, attempt);
    return attempt;
  }

  return { settleMarket };
}

/* ------------------------------------------------------------------ */
/* Default instance                                                    */
/* ------------------------------------------------------------------ */

// On `globalThis` so the lock survives dev hot-reloads, like the store.
const globalForSettle = globalThis as unknown as {
  __greekbetSettleLocks?: Map<string, Promise<SettleResult>>;
};

let defaultSettler: Settler | undefined;

function settler(): Settler {
  defaultSettler ??= createSettler({
    getMarket: (id) => db.getMarket(id),
    updateMarket: (id, patch) => db.updateMarket(id, patch),
    getChainMarket,
    closeMarket,
    resolveMarket,
    resolverKeypair,
    feePayerKeypair,
    refreshProjection: () => void projection(),
    now: () => Date.now(),
    locks: (globalForSettle.__greekbetSettleLocks ??= new Map()),
  });
  return defaultSettler;
}

/** Close and resolve a market on chain from its resolution record. Never throws. */
export function settleMarket(marketId: string): Promise<SettleResult> {
  return settler().settleMarket(marketId);
}
