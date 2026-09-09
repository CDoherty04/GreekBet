/**
 * In-memory adapter, for tests and for the plan's Option C (same-process
 * consumer).
 *
 * It exists mainly to keep the {@link OutputAdapter} boundary honest: a second
 * implementation that shares no code with the file one proves the interface is
 * actually an abstraction and not a description of `JsonlOutput`.
 */

import type { ParsedEvent } from "../types";
import type { OutputAdapter } from "./adapter";

export class MemoryOutput implements OutputAdapter {
  readonly name = "memory";
  readonly events: ParsedEvent[] = [];
  private opened = false;
  private closed = false;

  /** Optional hook, so a same-process consumer can subscribe directly. */
  constructor(private readonly onEmit?: (events: ParsedEvent[]) => void) {}

  async open(): Promise<void> {
    this.opened = true;
  }

  async emit(events: ParsedEvent[]): Promise<void> {
    if (!this.opened) throw new Error("MemoryOutput.emit before open()");
    if (this.closed) throw new Error("MemoryOutput.emit after close()");
    this.events.push(...events);
    this.onEmit?.(events);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * Adapter that fails on demand, to test that a failed emit does not advance the
 * checkpoint. Without this, the "durable before resolving" contract in
 * {@link OutputAdapter} is only a comment.
 */
export class FailingOutput implements OutputAdapter {
  readonly name = "failing";
  private calls = 0;

  constructor(private readonly failOnCall = 1) {}

  async open(): Promise<void> {}

  async emit(_events: ParsedEvent[]): Promise<void> {
    this.calls++;
    if (this.calls === this.failOnCall) {
      throw new Error("simulated output failure");
    }
  }

  async close(): Promise<void> {}
}
