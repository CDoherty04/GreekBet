/**
 * The handoff boundary (plan §4).
 *
 * Persistence is a separate concern and a separate process. Everything upstream
 * of this interface — connection handling, decoding, dedup, ordering — is
 * unaware of where events end up.
 *
 * The exit criterion is that swapping the file adapter for a queue "wouldn't
 * require touching the decoder or dedup logic". That is enforced structurally:
 * this interface names nothing file-specific, and the adapters are the only
 * modules that import an I/O library.
 *
 * `emit` takes a batch rather than a single event so a queue implementation can
 * pipeline a whole slot in one round trip. Callers must treat it as all-or-
 * nothing: an adapter that throws has emitted none of the batch, and the
 * checkpoint is therefore not advanced.
 */

import type { ParsedEvent } from "../types";

export interface OutputAdapter {
  /** Human-readable, for logs and diagnostics. */
  readonly name: string;

  /** Called once before any `emit`. */
  open(): Promise<void>;

  /**
   * Emit a batch in the order given. Must be durable before resolving — the
   * checkpoint advances on the strength of this promise, so resolving early
   * turns a crash into silent data loss.
   */
  emit(events: ParsedEvent[]): Promise<void>;

  /** Flush and release resources. Safe to call more than once. */
  close(): Promise<void>;
}
