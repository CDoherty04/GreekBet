/**
 * Option A from the plan §4: newline-delimited JSON on local disk.
 *
 * One event per line, appended. A separate writer process tails the file. Chosen
 * for v1 because it needs no infrastructure and is debuggable by reading it —
 * `tail -f`, `wc -l`, `jq` all work — which matters a great deal while the
 * event shapes are still being shaken out.
 *
 * Its real limitation is honest: it is local-only, so it stops being viable the
 * moment the indexer and the writer live on different machines. That is what the
 * {@link OutputAdapter} boundary is for.
 */

import * as fs from "fs";
import * as path from "path";

import type { ParsedEvent } from "../types";
import type { OutputAdapter } from "./adapter";

export interface JsonlOutputOptions {
  filePath: string;
  /**
   * `fsync` after every batch. Default true.
   *
   * Without it the OS may hold writes in the page cache, and a machine crash
   * loses events the checkpoint has already been advanced past — exactly the
   * silent data loss the adapter contract forbids. Disable only for throughput
   * tests where the data does not matter.
   */
  fsync?: boolean;
}

export class JsonlOutput implements OutputAdapter {
  readonly name: string;
  private fd: number | null = null;
  private readonly fsyncEnabled: boolean;
  private _written = 0;

  constructor(private readonly options: JsonlOutputOptions) {
    this.name = `jsonl(${options.filePath})`;
    this.fsyncEnabled = options.fsync ?? true;
  }

  async open(): Promise<void> {
    if (this.fd !== null) return;
    fs.mkdirSync(path.dirname(this.options.filePath), { recursive: true });
    // "a" is atomic per-write for the small records written here, so a
    // concurrently tailing reader never observes a torn line.
    this.fd = fs.openSync(this.options.filePath, "a");
  }

  async emit(events: ParsedEvent[]): Promise<void> {
    if (events.length === 0) return;
    if (this.fd === null) throw new Error("JsonlOutput.emit before open()");

    // Build the whole batch first: one write syscall, and a serialisation error
    // leaves the file untouched rather than half-appended.
    let payload = "";
    for (const ev of events) payload += JSON.stringify(ev) + "\n";

    fs.writeFileSync(this.fd, payload, "utf8");
    if (this.fsyncEnabled) fs.fsyncSync(this.fd);
    this._written += events.length;
  }

  async close(): Promise<void> {
    if (this.fd === null) return;
    if (this.fsyncEnabled) fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
    this.fd = null;
  }

  get written(): number {
    return this._written;
  }
}
