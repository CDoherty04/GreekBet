/**
 * Orchestration: connection → backfill → live stream → dedup → output.
 *
 * ## The startup sequence, and why it is ordered this way
 *
 * 1. Load the checkpoint and seed the deduplicator with the boundary slot's
 *    signatures.
 * 2. **Subscribe first, buffer what arrives.** Subscribing after the backfill
 *    would leave a hole: anything landing between "backfill read the last page"
 *    and "subscription became active" is in neither. Subscribing first makes the
 *    two windows overlap instead, and the deduplicator absorbs the overlap.
 * 3. Backfill from the checkpoint to now.
 * 4. Flush the buffer, then stream live.
 *
 * The same sequence runs on every reconnect (plan §2.3), which is why it lives
 * in one method rather than being spread across start-up and error handling.
 */

import { PublicKey } from "@solana/web3.js";

import { CheckpointStore } from "./checkpoint";
import { Decoder } from "./decoder";
import { Deduplicator } from "./dedup";
import type { OutputAdapter } from "./output/adapter";
import { RpcChainSource, type ChainSource } from "./rpc";
import type { LogBatch, ParsedEvent } from "./types";

export interface IndexerOptions {
  endpoint: string;
  programId: PublicKey;
  checkpointPath: string;
  output: OutputAdapter;
  /** Injectable for tests; defaults to a real RPC connection. */
  chainSource?: ChainSource;
  /**
   * Re-fetch each live transaction to obtain its block time and authoritative
   * status. Default true.
   *
   * `logsSubscribe` carries neither. Without this the live path emits
   * `block_time: null`, and the plan (§3.1) wants a block time on every event
   * because the downstream writer orders by it. The cost is one extra
   * `getTransaction` per program transaction — acceptable at this volume, and
   * the retry layer absorbs the 429s. Turn it off only if rate limits bite
   * harder than missing timestamps hurt.
   */
  hydrateLiveEvents?: boolean;
  /** Backoff between reconnect attempts, ms. Doubles, capped at 30s. */
  reconnectBaseDelayMs?: number;
  dedupCapacity?: number;
  logger?: Logger;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  info: (m, meta) => console.log(`[info]  ${m}`, meta ?? ""),
  warn: (m, meta) => console.warn(`[warn]  ${m}`, meta ?? ""),
  error: (m, meta) => console.error(`[error] ${m}`, meta ?? ""),
};

export interface IndexerStats {
  emitted: number;
  duplicatesSuppressed: number;
  backfills: number;
  reconnects: number;
  decodeSkips: number;
}

export class Indexer {
  private readonly checkpoint: CheckpointStore;
  private readonly decoder: Decoder;
  private readonly dedup: Deduplicator;
  private readonly source: ChainSource;
  private readonly output: OutputAdapter;
  private readonly log: Logger;
  private readonly hydrate: boolean;
  private readonly reconnectBaseDelayMs: number;

  private unsubscribe: (() => Promise<void>) | null = null;
  private liveBuffer: LogBatch[] = [];
  private buffering = true;
  private running = false;
  private stats: IndexerStats = {
    emitted: 0,
    duplicatesSuppressed: 0,
    backfills: 0,
    reconnects: 0,
    decodeSkips: 0,
  };

  constructor(private readonly options: IndexerOptions) {
    this.log = options.logger ?? consoleLogger;
    this.checkpoint = new CheckpointStore(options.checkpointPath);
    this.decoder = new Decoder({
      onSkipped: (reason) => {
        this.stats.decodeSkips++;
        this.log.warn("decode skipped", { reason });
      },
    });
    this.dedup = new Deduplicator({ capacity: options.dedupCapacity });
    this.output = options.output;
    this.hydrate = options.hydrateLiveEvents ?? true;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1000;
    this.source =
      options.chainSource ??
      new RpcChainSource({
        endpoint: options.endpoint,
        programId: options.programId,
        onRetry: (attempt, err, delayMs) =>
          this.log.warn("rpc retry", { attempt, delayMs, error: err.message }),
      });
  }

  getStats(): Readonly<IndexerStats> {
    return { ...this.stats, duplicatesSuppressed: this.dedup.duplicates };
  }

  async start(): Promise<void> {
    if (this.running) throw new Error("indexer already started");
    this.running = true;

    const state = this.checkpoint.load();
    // Seed the boundary so the slot we resume *into* is replayed but not
    // re-emitted. See checkpoint.ts for why the slot alone is not enough.
    for (const sig of state.signaturesAtSlot) this.dedup.seedSignature(sig);
    this.log.info("checkpoint loaded", {
      slot: state.slot,
      boundarySignatures: state.signaturesAtSlot.length,
    });

    await this.output.open();
    await this.connectAndCatchUp();
  }

  /**
   * Subscribe, backfill, then flush the buffer. Used at startup and on every
   * reconnect — a gap after a dropped socket is the same problem as a gap after
   * a restart, so it gets the same code path.
   */
  private async connectAndCatchUp(): Promise<void> {
    this.buffering = true;
    this.liveBuffer = [];

    this.unsubscribe = await this.source.subscribeLogs(
      (batch) => this.onLiveBatch(batch),
      (err) => this.onStreamError(err),
    );
    this.log.info("subscribed to program logs");

    await this.backfill();

    // Anything that arrived while the backfill ran is now safe to process; the
    // deduplicator drops whatever the backfill already covered.
    this.buffering = false;
    const buffered = this.liveBuffer;
    this.liveBuffer = [];
    for (const batch of buffered) await this.processBatch(batch);
    if (buffered.length > 0) {
      this.log.info("flushed live buffer", { batches: buffered.length });
    }
  }

  /** Walk signature history forward from the checkpoint (plan §2.2). */
  private async backfill(): Promise<void> {
    this.stats.backfills++;
    const from = this.checkpoint.current.slot;
    this.log.info("backfill starting", { fromSlot: from });

    const signatures = await this.source.getSignaturesSince(from, 1000);
    let processed = 0;

    for (const info of signatures) {
      const batch = await this.source.getLogs(info.signature);
      if (!batch) {
        // A confirmed signature can 404 from getTransaction for a few seconds
        // on devnet. Skipping is safe: the checkpoint has not advanced past it,
        // so the next backfill picks it up.
        this.log.warn("signature not yet retrievable, deferring", {
          signature: info.signature,
        });
        continue;
      }
      await this.processBatch(batch);
      processed++;
    }

    this.log.info("backfill complete", { signatures: signatures.length, processed });
  }

  private onLiveBatch(batch: LogBatch): void {
    if (this.buffering) {
      this.liveBuffer.push(batch);
      return;
    }
    // Fire-and-forget with explicit error capture: onLogs is a sync callback, so
    // an unhandled rejection here would otherwise take the process down.
    void this.processBatch(batch).catch((err) => {
      this.log.error("live batch failed", { error: (err as Error).message });
    });
  }

  private async processBatch(batch: LogBatch): Promise<void> {
    let effective = batch;

    // logsSubscribe gives no block time and only a preliminary status.
    if (this.hydrate && batch.blockTime === null) {
      try {
        const full = await this.source.getLogs(batch.signature);
        if (full) effective = full;
      } catch (err) {
        // Emit with a null block time rather than dropping the event: a missing
        // timestamp is a smaller problem than a missing trade.
        this.log.warn("hydrate failed, emitting without block time", {
          signature: batch.signature,
          error: (err as Error).message,
        });
      }
    }

    const events = this.decoder.decode(effective);
    if (events.length === 0) return;

    const fresh: ParsedEvent[] = [];
    for (const ev of events) {
      if (this.dedup.admit(ev.signature, ev.event_index)) fresh.push(ev);
    }
    if (fresh.length === 0) return;

    // Output first, then checkpoint. If the process dies between the two, the
    // batch is re-emitted on restart and the deduplicator suppresses it. The
    // reverse order would lose events outright — always prefer replay over loss.
    await this.output.emit(fresh);
    this.stats.emitted += fresh.length;

    this.checkpoint.advance(effective.slot, effective.signature);
    this.checkpoint.save();
  }

  private onStreamError(err: Error): void {
    this.log.error("stream error", { error: err.message });
    void this.reconnect();
  }

  /** Reconnect, then immediately backfill to close the gap (plan §2.3). */
  private async reconnect(): Promise<void> {
    if (!this.running) return;
    this.stats.reconnects++;

    if (this.unsubscribe) {
      try {
        await this.unsubscribe();
      } catch {
        /* socket already gone */
      }
      this.unsubscribe = null;
    }

    let delay = this.reconnectBaseDelayMs;
    for (let attempt = 1; this.running; attempt++) {
      await new Promise((r) => setTimeout(r, delay));
      try {
        this.log.info("reconnecting", { attempt });
        await this.connectAndCatchUp();
        this.log.info("reconnected");
        return;
      } catch (err) {
        this.log.error("reconnect failed", { attempt, error: (err as Error).message });
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.unsubscribe) {
      await this.unsubscribe().catch(() => {});
      this.unsubscribe = null;
    }
    await this.source.close();
    await this.output.close();
    this.checkpoint.save();
    this.log.info("stopped", this.getStats() as unknown as Record<string, unknown>);
  }
}
