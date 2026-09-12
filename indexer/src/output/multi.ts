/**
 * Fan-out adapter: emit to several sinks. All must succeed (all-or-nothing
 * for the checkpoint contract). Prefer durable sinks first in the list.
 */

import type { ParsedEvent } from "../types";
import type { OutputAdapter } from "./adapter";

export class MultiOutput implements OutputAdapter {
  readonly name: string;

  constructor(private readonly adapters: OutputAdapter[]) {
    if (adapters.length === 0) {
      throw new Error("MultiOutput requires at least one adapter");
    }
    this.name = `multi(${adapters.map((a) => a.name).join("+")})`;
  }

  async open(): Promise<void> {
    for (const a of this.adapters) await a.open();
  }

  async emit(events: ParsedEvent[]): Promise<void> {
    for (const a of this.adapters) await a.emit(events);
  }

  async close(): Promise<void> {
    for (const a of this.adapters) await a.close();
  }
}
