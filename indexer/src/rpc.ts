/**
 * The chain-access boundary.
 *
 * Everything above this interface is provider-agnostic, which is what makes the
 * "raw RPC now, Helius later" decision reversible: a Helius (or Triton, or
 * self-hosted) implementation satisfies {@link ChainSource} and nothing in the
 * decoder, deduplicator or orchestrator changes.
 *
 * ## Retries are not optional here
 *
 * Measured against this exact program on devnet: **429s arrive in bursts of 4–8
 * per run**, `getTokenLargestAccounts` is refused outright with a per-method
 * limit, a *confirmed* signature can 404 from `getTransaction` for several
 * seconds, and latency runs 600–2,000 ms against 40–500 ms locally. So a
 * transient-aware retry is a correctness requirement, not defensive polish —
 * without it the indexer reports gaps that are not really gaps.
 */

import {
  Connection,
  PublicKey,
  type ConfirmedSignatureInfo,
  type Finality,
} from "@solana/web3.js";

import type { LogBatch } from "./types";

export interface ChainSource {
  readonly name: string;

  /**
   * Signatures touching the program, **oldest first**.
   *
   * The underlying RPC returns newest-first and pages backwards; implementations
   * must reverse so callers can process in chain order without buffering
   * everything.
   */
  getSignaturesSince(
    afterSlot: number | null,
    limit: number,
  ): Promise<ConfirmedSignatureInfo[]>;

  /** Fetch one transaction's logs. `null` if not (yet) retrievable. */
  getLogs(signature: string): Promise<LogBatch | null>;

  /** Subscribe to live logs. Returns an unsubscribe function. */
  subscribeLogs(
    onBatch: (batch: LogBatch) => void,
    onError: (err: Error) => void,
  ): Promise<() => Promise<void>>;

  close(): Promise<void>;
}

export interface RpcOptions {
  endpoint: string;
  programId: PublicKey;
  /**
   * `confirmed` by default, deliberately.
   *
   * `processed` can return state that is later rolled back, and the local test
   * suite already had to pin `confirmed` because a read straight after a write
   * could come back stale. `finalized` is safer still but adds ~13 s of latency,
   * which makes a "real-time" indexer not real-time.
   */
  commitment?: Finality;
  maxRetries?: number;
  /** Base backoff in ms; doubles per attempt with jitter. */
  baseDelayMs?: number;
  onRetry?: (attempt: number, err: Error, delayMs: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Errors worth retrying: rate limits, transient network faults, and the
 * "confirmed but not yet queryable" window.
 *
 * Deliberately a allowlist rather than "retry everything" — retrying a genuine
 * bug (a malformed request, a bad program id) just hides it behind a delay.
 */
export function isTransient(err: unknown): boolean {
  const msg = (err as Error)?.message?.toLowerCase() ?? "";
  return (
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("rate limit") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("connection closed")
  );
}

export class RpcChainSource implements ChainSource {
  readonly name: string;
  private readonly connection: Connection;
  private readonly programId: PublicKey;
  private readonly commitment: Finality;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly onRetry: (attempt: number, err: Error, delayMs: number) => void;
  private subscriptionId: number | null = null;

  constructor(options: RpcOptions) {
    this.name = `rpc(${options.endpoint})`;
    this.programId = options.programId;
    this.commitment = options.commitment ?? "confirmed";
    this.maxRetries = options.maxRetries ?? 6;
    this.baseDelayMs = options.baseDelayMs ?? 400;
    this.onRetry = options.onRetry ?? (() => {});
    this.connection = new Connection(options.endpoint, {
      commitment: this.commitment,
      // The websocket endpoint is derived from the HTTP one by web3.js.
      disableRetryOnRateLimit: true, // handled here, with visibility
    });
  }

  /** Retry with exponential backoff and full jitter. */
  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err as Error;
        if (!isTransient(err) || attempt === this.maxRetries) throw err;
        // Full jitter: without it, several retrying calls resynchronise and
        // hit the same rate limit together on every subsequent attempt.
        const ceiling = this.baseDelayMs * 2 ** attempt;
        const delay = Math.floor(Math.random() * ceiling);
        this.onRetry(attempt + 1, lastErr, delay);
        await sleep(delay);
      }
    }
    throw lastErr ?? new Error(`${label} failed`);
  }

  async getSignaturesSince(
    afterSlot: number | null,
    limit = 1000,
  ): Promise<ConfirmedSignatureInfo[]> {
    // getSignaturesForAddress walks backwards from newest, 1000 at a time. To
    // resume from a slot we page back until we pass it, then reverse. There is
    // no server-side "since slot" filter, so this is the only way.
    const collected: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;

    for (;;) {
      const page = await this.withRetry("getSignaturesForAddress", () =>
        this.connection.getSignaturesForAddress(
          this.programId,
          { before, limit: Math.min(1000, limit) },
          this.commitment,
        ),
      );
      if (page.length === 0) break;

      let reachedCheckpoint = false;
      for (const info of page) {
        if (afterSlot !== null && info.slot < afterSlot) {
          reachedCheckpoint = true;
          break;
        }
        collected.push(info);
      }

      if (reachedCheckpoint || page.length < Math.min(1000, limit)) break;
      before = page[page.length - 1]?.signature;
      if (!before) break;
      if (collected.length >= limit) break;
    }

    // Oldest first, so downstream sees chain order (plan §3.3).
    collected.sort((a, b) => a.slot - b.slot);
    return collected;
  }

  async getLogs(signature: string): Promise<LogBatch | null> {
    const tx = await this.withRetry("getTransaction", () =>
      this.connection.getTransaction(signature, {
        commitment: this.commitment,
        maxSupportedTransactionVersion: 0,
      }),
    );
    if (!tx || !tx.meta) return null;

    return {
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime ?? null,
      logs: tx.meta.logMessages ?? [],
      // A reverted transaction still has logs, and they can contain `emit!`
      // output from before the failure. The decoder drops these.
      failed: tx.meta.err !== null,
    };
  }

  async subscribeLogs(
    onBatch: (batch: LogBatch) => void,
    onError: (err: Error) => void,
  ): Promise<() => Promise<void>> {
    this.subscriptionId = this.connection.onLogs(
      this.programId,
      (logs, ctx) => {
        try {
          onBatch({
            signature: logs.signature,
            slot: ctx.slot,
            // logsSubscribe carries no block time. Left null rather than
            // guessed; the backfill path fills it in properly, and inventing a
            // local clock reading here would corrupt downstream ordering.
            blockTime: null,
            logs: logs.logs,
            failed: logs.err !== null,
          });
        } catch (err) {
          onError(err as Error);
        }
      },
      this.commitment,
    );

    return async () => {
      if (this.subscriptionId !== null) {
        try {
          await this.connection.removeOnLogsListener(this.subscriptionId);
        } catch {
          // Already gone (socket dropped) — nothing to release.
        }
        this.subscriptionId = null;
      }
    };
  }

  async close(): Promise<void> {
    if (this.subscriptionId !== null) {
      try {
        await this.connection.removeOnLogsListener(this.subscriptionId);
      } catch {
        /* ignore */
      }
      this.subscriptionId = null;
    }
  }
}
