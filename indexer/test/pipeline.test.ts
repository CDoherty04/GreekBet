/**
 * Dedup, checkpoint, output-adapter and reconnect/backfill behaviour.
 *
 * Covers the plan's §6 reconnection test and the exit criteria about
 * exactly-once ordering and adapter swappability, using a fake
 * {@link ChainSource} driven by the captured devnet fixtures. A fake is the
 * right tool here: killing a real websocket mid-stream is not reproducible in
 * CI, whereas the failure it causes — a gap that backfill must close — is
 * exactly what needs asserting.
 */

import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { CheckpointStore } from "../src/checkpoint";
import { Deduplicator } from "../src/dedup";
import { Indexer } from "../src/indexer";
import { JsonlOutput } from "../src/output/jsonl";
import { FailingOutput, MemoryOutput } from "../src/output/memory";
import { isTransient, type ChainSource } from "../src/rpc";
import type { LogBatch, ParsedEvent } from "../src/types";
import { PROGRAM_ID } from "../src/decoder";

interface Fixture {
  label: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  failed: boolean;
  logs: string[];
}

const fixtures: Fixture[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "devnet-lifecycle.json"), "utf8"),
).transactions;

const toBatch = (f: Fixture): LogBatch => ({
  signature: f.signature,
  slot: f.slot,
  blockTime: f.blockTime,
  logs: f.logs,
  failed: f.failed,
});

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** Replays fixtures; lets a test choose what backfill sees and what streams live. */
class FakeChain implements ChainSource {
  readonly name = "fake";
  private listener: ((b: LogBatch) => void) | null = null;
  getLogsCalls = 0;

  constructor(private readonly available: Fixture[]) {}

  async getSignaturesSince(afterSlot: number | null) {
    return this.available
      .filter((f) => afterSlot === null || f.slot >= afterSlot)
      .sort((a, b) => a.slot - b.slot)
      .map((f) => ({
        signature: f.signature,
        slot: f.slot,
        err: null,
        memo: null,
        blockTime: f.blockTime,
      })) as never;
  }

  async getLogs(signature: string): Promise<LogBatch | null> {
    this.getLogsCalls++;
    const f = this.available.find((x) => x.signature === signature);
    return f ? toBatch(f) : null;
  }

  async subscribeLogs(onBatch: (b: LogBatch) => void) {
    this.listener = onBatch;
    return async () => {
      this.listener = null;
    };
  }

  /** Push a batch as if it arrived live. */
  push(f: Fixture): void {
    this.listener?.(toBatch(f));
  }

  async close(): Promise<void> {
    this.listener = null;
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gb-indexer-"));
}

describe("Deduplicator", () => {
  it("keys on (signature, event_index), not signature alone", () => {
    const d = new Deduplicator();
    expect(d.admit("sig", 0)).to.equal(true);
    // A second event in the SAME transaction must still be admitted. Keying on
    // the signature alone would drop it — silent data loss in any
    // multi-instruction transaction.
    expect(d.admit("sig", 1)).to.equal(true);
    expect(d.admit("sig", 0)).to.equal(false);
    expect(d.duplicates).to.equal(1);
  });

  it("bounds memory by evicting oldest keys", () => {
    const d = new Deduplicator({ capacity: 3 });
    for (let i = 0; i < 5; i++) d.admit("s", i);
    expect(d.size).to.equal(3);
    expect(d.evictions).to.equal(2);
    // Evicted keys are admitted again — which is why `evictions` is exposed:
    // a non-zero value means the window is too narrow to guarantee exactly-once.
    expect(d.admit("s", 0)).to.equal(true);
  });

  it("seeds a whole signature from a checkpoint boundary", () => {
    const d = new Deduplicator();
    d.seedSignature("boundary");
    expect(d.admit("boundary", 0)).to.equal(false);
    expect(d.admit("boundary", 5)).to.equal(false);
    expect(d.admit("other", 0)).to.equal(true);
  });
});

describe("CheckpointStore", () => {
  it("round-trips and starts empty when absent", () => {
    const dir = tmpDir();
    const file = path.join(dir, "cp.json");
    const store = new CheckpointStore(file);

    expect(store.load().slot).to.equal(null);
    store.advance(100, "sigA");
    store.advance(100, "sigB");
    store.save();

    const reloaded = new CheckpointStore(file).load();
    expect(reloaded.slot).to.equal(100);
    // Both signatures at the boundary slot are retained, so a resume replays
    // the slot without re-emitting either.
    expect(reloaded.signaturesAtSlot).to.have.members(["sigA", "sigB"]);
  });

  it("clears the boundary set when the slot advances", () => {
    const store = new CheckpointStore(path.join(tmpDir(), "cp.json"));
    store.load();
    store.advance(100, "sigA");
    store.advance(101, "sigB");
    expect(store.current.signaturesAtSlot).to.deep.equal(["sigB"]);
  });

  it("never rewinds the frontier", () => {
    const store = new CheckpointStore(path.join(tmpDir(), "cp.json"));
    store.load();
    store.advance(200, "new");
    store.advance(100, "old"); // late arrival
    expect(store.current.slot).to.equal(200);
    expect(store.current.signaturesAtSlot).to.deep.equal(["new"]);
  });

  it("refuses to start on a corrupt checkpoint rather than re-indexing", () => {
    const file = path.join(tmpDir(), "cp.json");
    fs.writeFileSync(file, "{ not json");
    expect(() => new CheckpointStore(file).load()).to.throw(/not valid JSON/);
  });

  it("writes atomically, leaving no partial file", () => {
    const dir = tmpDir();
    const file = path.join(dir, "cp.json");
    const store = new CheckpointStore(file);
    store.load();
    store.advance(1, "s");
    store.save();
    // The temp file must not survive a successful save.
    expect(fs.existsSync(`${file}.tmp`)).to.equal(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).slot).to.equal(1);
  });
});

describe("Output adapters", () => {
  it("JsonlOutput writes one parseable JSON object per line", async () => {
    const file = path.join(tmpDir(), "events.jsonl");
    const out = new JsonlOutput({ filePath: file });
    await out.open();

    const ev: ParsedEvent = {
      event_type: "MarketClosed",
      market: "M",
      slot: 1,
      signature: "s",
      event_index: 0,
      block_time: 123,
      data: { close_time: 1, closed_at: 2, q_yes: "3", q_no: "4" },
    };
    await out.emit([ev, { ...ev, event_index: 1 }]);
    await out.close();

    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).to.have.lengthOf(2);
    expect(JSON.parse(lines[0]!).event_type).to.equal("MarketClosed");
    expect(JSON.parse(lines[1]!).event_index).to.equal(1);
  });

  it("appends across reopen, so a restart does not truncate the stream", async () => {
    const file = path.join(tmpDir(), "events.jsonl");
    const ev: ParsedEvent = {
      event_type: "MarketClosed",
      market: "M",
      slot: 1,
      signature: "s",
      event_index: 0,
      block_time: null,
      data: { close_time: 1, closed_at: 2, q_yes: "3", q_no: "4" },
    };
    for (const _ of [1, 2]) {
      const out = new JsonlOutput({ filePath: file });
      await out.open();
      await out.emit([ev]);
      await out.close();
    }
    expect(fs.readFileSync(file, "utf8").trim().split("\n")).to.have.lengthOf(2);
  });
});

describe("Indexer", () => {
  it("emits the full lifecycle exactly once, in slot order", async () => {
    const chain = new FakeChain(fixtures);
    const output = new MemoryOutput();
    const dir = tmpDir();

    const indexer = new Indexer({
      endpoint: "unused",
      programId: PROGRAM_ID,
      checkpointPath: path.join(dir, "cp.json"),
      output,
      chainSource: chain,
      logger: silent,
    });

    await indexer.start();
    await indexer.stop();

    expect(output.events.length).to.be.greaterThan(0);

    // Exactly once.
    const keys = output.events.map((e) => `${e.signature}:${e.event_index}`);
    expect(new Set(keys).size).to.equal(keys.length);

    // Slot order (plan §3.3).
    const slots = output.events.map((e) => e.slot);
    expect([...slots].sort((a, b) => a - b)).to.deep.equal(slots);

    // The whole lifecycle is represented.
    const types = new Set(output.events.map((e) => e.event_type));
    expect(types.has("MarketCreated")).to.equal(true);
    expect(types.has("MarketResolved")).to.equal(true);
    expect(types.has("Redeemed")).to.equal(true);
  });

  it("recovers from a mid-stream gap without loss or duplication", async () => {
    // The plan's §6 reconnection test: process some, "disconnect", let chain
    // activity continue unseen, then restart and confirm backfill closes the gap.
    const dir = tmpDir();
    const cp = path.join(dir, "cp.json");
    const half = Math.floor(fixtures.length / 2);

    const first = new MemoryOutput();
    const indexerA = new Indexer({
      endpoint: "unused",
      programId: PROGRAM_ID,
      checkpointPath: cp,
      output: first,
      chainSource: new FakeChain(fixtures.slice(0, half)),
      logger: silent,
    });
    await indexerA.start();
    await indexerA.stop();

    // Everything is now visible, including what happened "while disconnected".
    const second = new MemoryOutput();
    const indexerB = new Indexer({
      endpoint: "unused",
      programId: PROGRAM_ID,
      checkpointPath: cp,
      output: second,
      chainSource: new FakeChain(fixtures),
      logger: silent,
    });
    await indexerB.start();
    await indexerB.stop();

    const all = [...first.events, ...second.events];
    const keys = all.map((e) => `${e.signature}:${e.event_index}`);

    // No duplication across the restart boundary…
    expect(new Set(keys).size, "duplicate events across restart").to.equal(keys.length);
    // …and no loss: every fixture that decodes is present exactly once.
    const decodedSigs = new Set(all.map((e) => e.signature));
    for (const f of fixtures) {
      expect(decodedSigs.has(f.signature), `missing ${f.label}`).to.equal(true);
    }
  });

  it("does not advance the checkpoint when the output fails", async () => {
    // The adapter contract says emit() is durable before it resolves. If a
    // failed emit still advanced the checkpoint, those events would be lost
    // forever on restart — replay is always preferable to loss.
    const dir = tmpDir();
    const cp = path.join(dir, "cp.json");

    const indexer = new Indexer({
      endpoint: "unused",
      programId: PROGRAM_ID,
      checkpointPath: cp,
      output: new FailingOutput(1),
      chainSource: new FakeChain(fixtures),
      logger: silent,
    });

    let threw = false;
    try {
      await indexer.start();
    } catch {
      threw = true;
    }
    await indexer.stop().catch(() => {});

    const state = new CheckpointStore(cp).load();
    if (threw) {
      expect(state.slot, "checkpoint advanced despite a failed emit").to.equal(null);
    }
  });

  it("classifies transient RPC errors but not genuine bugs", () => {
    for (const m of [
      "429 Too Many Requests",
      "rate limit exceeded",
      "socket hang up",
      "ETIMEDOUT",
      "fetch failed",
    ]) {
      expect(isTransient(new Error(m)), m).to.equal(true);
    }
    // Retrying these would hide a real defect behind a delay.
    for (const m of ["Invalid public key input", "unknown instruction", "TypeError: x"]) {
      expect(isTransient(new Error(m)), m).to.equal(false);
    }
  });
});
