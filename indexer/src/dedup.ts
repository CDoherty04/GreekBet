/**
 * Exactly-once emission (plan §3.2).
 *
 * Backfill and the live subscription deliberately overlap — that overlap is what
 * closes the gap after a reconnect — so the same transaction routinely arrives
 * twice. Filtering here means the downstream writer never has to guess whether
 * it is seeing a duplicate.
 *
 * ## Why the key is `(signature, event_index)` and not `signature`
 *
 * One transaction can carry several instructions and therefore several events.
 * Keying on the signature alone would drop every event after the first in any
 * multi-instruction transaction — a silent, data-losing bug that a single-trade
 * test would never catch.
 *
 * ## Why the set is bounded
 *
 * An unbounded set grows without limit in a process meant to run for weeks. The
 * window only has to be wide enough to cover the overlap between a backfill and
 * the live stream, so entries are evicted in insertion order once the cap is
 * hit. The cap is in *events*, and the default is far larger than any plausible
 * reconnect window; {@link Deduplicator.evictions} is exposed so an operator can
 * tell whether it was ever actually reached.
 */

export interface DeduplicatorOptions {
  /** Maximum keys retained. Default 100,000. */
  capacity?: number;
  /** Keys to pre-seed, e.g. the checkpoint's boundary-slot signatures. */
  seed?: Iterable<string>;
}

export class Deduplicator {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private readonly capacity: number;
  private _evictions = 0;
  private _duplicates = 0;

  constructor(options: DeduplicatorOptions = {}) {
    this.capacity = options.capacity ?? 100_000;
    if (this.capacity < 1) throw new Error("dedup capacity must be >= 1");
    for (const key of options.seed ?? []) this.remember(key);
  }

  private static key(signature: string, eventIndex: number): string {
    return `${signature}:${eventIndex}`;
  }

  private remember(key: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.order.push(key);
    while (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) {
        this.seen.delete(evicted);
        this._evictions++;
      }
    }
  }

  /**
   * Seed an entire transaction as already-emitted, without knowing how many
   * events it contained.
   *
   * Used when resuming from a checkpoint: the boundary slot's signatures are
   * known, but their event counts are not — that would have meant storing far
   * more in the checkpoint file. Marking a generous span of indices costs a few
   * hundred bytes of memory and guarantees the boundary is never re-emitted.
   */
  seedSignature(signature: string, maxEvents = 32): void {
    for (let i = 0; i < maxEvents; i++) {
      this.remember(Deduplicator.key(signature, i));
    }
  }

  /** True if this is the first time `(signature, eventIndex)` has been seen. */
  admit(signature: string, eventIndex: number): boolean {
    const key = Deduplicator.key(signature, eventIndex);
    if (this.seen.has(key)) {
      this._duplicates++;
      return false;
    }
    this.remember(key);
    return true;
  }

  /** Number of duplicate events suppressed. Expected to be non-zero after a reconnect. */
  get duplicates(): number {
    return this._duplicates;
  }

  /**
   * Keys dropped because the window filled.
   *
   * Non-zero means the window is narrower than the overlap being replayed, and
   * duplicates could get through. It is a signal to raise `capacity`, which is
   * why it is surfaced rather than kept internal.
   */
  get evictions(): number {
    return this._evictions;
  }

  get size(): number {
    return this.seen.size;
  }
}
