/**
 * The indexer's own bookkeeping: how far it has processed.
 *
 * This is the one piece of state the indexer owns (plan §2.2), deliberately
 * separate from both the application database and the output stream.
 *
 * ## Why the boundary signatures are stored, not just a slot
 *
 * A slot can contain several transactions touching the program, and a crash can
 * land in the middle of one. Resuming from `slot + 1` would silently skip the
 * rest of that slot; resuming from `slot` alone would re-emit everything in it.
 *
 * So the checkpoint records the slot **and every signature already processed at
 * that slot**. Backfill resumes *inclusive* of the slot and the deduplicator is
 * seeded with those signatures, so the boundary is replayed but not re-emitted.
 * The set stays small — it is one slot's worth, not the whole history — which is
 * what makes a plain JSON file a sound choice here rather than a database.
 */

import * as fs from "fs";
import * as path from "path";

export interface CheckpointState {
  /** Highest slot fully or partially processed. `null` before the first run. */
  slot: number | null;
  /** Signatures already emitted at exactly {@link slot}. */
  signaturesAtSlot: string[];
  /** Most recent signature processed, for operator diagnostics. */
  lastSignature: string | null;
  /** ISO-8601, for operator diagnostics only — never used for ordering. */
  updatedAt: string | null;
  /** Guards against a future format change silently misreading an old file. */
  version: 1;
}

export const EMPTY_CHECKPOINT: CheckpointState = {
  slot: null,
  signaturesAtSlot: [],
  lastSignature: null,
  updatedAt: null,
  version: 1,
};

export class CheckpointStore {
  private state: CheckpointState = { ...EMPTY_CHECKPOINT };

  constructor(private readonly filePath: string) {}

  /**
   * Load from disk. A missing file is the normal first-run case and yields an
   * empty checkpoint, which makes the indexer backfill from genesis.
   *
   * A *corrupt* file is different and is not silently discarded: it would cause
   * a full re-index, which downstream may or may not tolerate. The operator is
   * told, and has to move the file aside deliberately.
   */
  load(): CheckpointState {
    if (!fs.existsSync(this.filePath)) {
      this.state = { ...EMPTY_CHECKPOINT };
      return this.state;
    }

    const raw = fs.readFileSync(this.filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `checkpoint at ${this.filePath} is not valid JSON (${(err as Error).message}). ` +
          `Refusing to start: silently ignoring it would re-index from genesis. ` +
          `Move it aside if that is what you intend.`,
      );
    }

    const obj = parsed as Partial<CheckpointState>;
    if (obj.version !== 1) {
      throw new Error(
        `checkpoint at ${this.filePath} has version ${String(obj.version)}, expected 1`,
      );
    }

    this.state = {
      slot: typeof obj.slot === "number" ? obj.slot : null,
      signaturesAtSlot: Array.isArray(obj.signaturesAtSlot)
        ? obj.signaturesAtSlot.filter((s): s is string => typeof s === "string")
        : [],
      lastSignature: typeof obj.lastSignature === "string" ? obj.lastSignature : null,
      updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : null,
      version: 1,
    };
    return this.state;
  }

  get current(): CheckpointState {
    return this.state;
  }

  /**
   * Record progress through `slot`.
   *
   * Advancing to a new slot clears the boundary set; staying on the same slot
   * appends to it. Moving backwards is ignored — out-of-order arrivals must not
   * rewind the frontier, or a restart would skip everything between.
   */
  advance(slot: number, signature: string): void {
    const prev = this.state.slot;
    if (prev === null || slot > prev) {
      this.state.slot = slot;
      this.state.signaturesAtSlot = [signature];
    } else if (slot === prev) {
      if (!this.state.signaturesAtSlot.includes(signature)) {
        this.state.signaturesAtSlot.push(signature);
      }
    } else {
      return; // older than the frontier; nothing to record
    }
    this.state.lastSignature = signature;
    this.state.updatedAt = new Date().toISOString();
  }

  /**
   * Persist atomically: write a sibling temp file, fsync it, then rename.
   *
   * A plain truncate-and-write can leave a half-written file if the process dies
   * mid-write, and `load()` would then refuse to start. `rename` within a
   * directory is atomic on POSIX, and Node's `renameSync` maps to `MoveFileEx`
   * with replace semantics on Windows, so the file is never observed partial.
   */
  save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });

    const tmp = `${this.filePath}.tmp`;
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(this.state, null, 2) + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.filePath);
  }
}
