/**
 * Decoder tests against **real devnet logs** (plan §6, first bullet).
 *
 * The fixtures in `fixtures/devnet-lifecycle.json` are the actual transactions
 * from the T10 lifecycle run against the deployed program, captured with
 * `scripts/capture-fixtures.ts`. That matters: hand-written log strings only
 * prove the decoder agrees with whoever invented the fixture, whereas these
 * carry the real borsh encodings, the real event discriminators, and the real
 * interleaved noise from the SPL Token and System programs.
 */

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import { Decoder } from "../src/decoder";
import type { LogBatch, ParsedEvent, TradeData } from "../src/types";

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

const byLabel = (label: string): Fixture => {
  const f = fixtures.find((x) => x.label === label);
  if (!f) throw new Error(`fixture ${label} missing`);
  return f;
};

const toBatch = (f: Fixture): LogBatch => ({
  signature: f.signature,
  slot: f.slot,
  blockTime: f.blockTime,
  logs: f.logs,
  failed: f.failed,
});

describe("Decoder", () => {
  const decoder = new Decoder();

  const decodeLabel = (label: string): ParsedEvent[] =>
    decoder.decode(toBatch(byLabel(label)));

  it("captured the full lifecycle", () => {
    expect(fixtures).to.have.lengthOf(10);
    expect(fixtures.every((f) => !f.failed)).to.equal(true);
  });

  it("decodes all six event types across the lifecycle", () => {
    const seen = new Set<string>();
    for (const f of fixtures) {
      for (const ev of decoder.decode(toBatch(f))) seen.add(ev.event_type);
    }
    expect([...seen].sort()).to.deep.equal([
      "MarketClosed",
      "MarketCreated",
      "MarketResolved",
      "Redeemed",
      "SharesBought",
      "SharesSold",
    ]);
  });

  it("stamps slot, signature, block_time and event_index on every event", () => {
    for (const f of fixtures) {
      for (const ev of decoder.decode(toBatch(f))) {
        expect(ev.slot).to.equal(f.slot);
        expect(ev.signature).to.equal(f.signature);
        expect(ev.block_time).to.equal(f.blockTime);
        expect(ev.event_index).to.be.a("number").and.at.least(0);
        expect(ev.market).to.be.a("string").with.length.greaterThan(31);
      }
    }
  });

  it("decodes MarketCreated with the seed equal to the LMSR subsidy", () => {
    const [ev] = decodeLabel("create_market");
    expect(ev).to.exist;
    expect(ev!.event_type).to.equal("MarketCreated");
    const d = ev!.data as unknown as Record<string, string>;

    // b·ln2 floored. b = 10 USDC = 10_000_000 base units on the devnet run.
    const b = BigInt(d.b as string);
    const seed = BigInt(d.seed_amount as string);
    const expected = (b * 693_147_180_559_945_309n) / 1_000_000_000_000_000_000n;
    const delta = seed > expected ? seed - expected : expected - seed;
    expect(Number(delta)).to.be.at.most(1, "seed should be b·ln2 within a base unit");

    expect(d.question_hash).to.match(/^[0-9a-f]{64}$/);
    expect(d.creator).to.be.a("string");
    expect(d.vault).to.be.a("string");
  });

  it("normalizes SharesBought and SharesSold onto one trade shape", () => {
    const [buy] = decodeLabel("buy_yes_a");
    const [sell] = decodeLabel("sell_a");
    expect(buy!.event_type).to.equal("SharesBought");
    expect(sell!.event_type).to.equal("SharesSold");

    const b = buy!.data as unknown as TradeData;
    const s = sell!.data as unknown as TradeData;

    // The program names the trader `buyer` on one event and `seller` on the
    // other; a consumer should not have to branch to find who traded.
    expect(b.is_buy).to.equal(true);
    expect(s.is_buy).to.equal(false);
    expect(b.user).to.be.a("string");
    expect(s.user).to.be.a("string");

    for (const t of [b, s]) {
      expect(t.outcome).to.be.oneOf(["Yes", "No"]);
      // Every amount is a decimal string, never a JSON number.
      for (const k of ["collateral", "shares", "avg_price", "price_yes_after"] as const) {
        expect(t[k], `${k} must be a decimal string`).to.match(/^\d+$/);
      }
      expect(Number(t.price_yes_after)).to.be.within(0, 1_000_000);
    }
  });

  it("shows price moving with the trades, which only the events carry", () => {
    // `Market` stores q_yes/q_no but not price, so this is unobtainable from
    // account state alone — the reason events are the primary source (§1.1).
    const yesA = (decodeLabel("buy_yes_a")[0]!.data as unknown as TradeData);
    const noB = (decodeLabel("buy_no_b")[0]!.data as unknown as TradeData);

    expect(yesA.outcome).to.equal("Yes");
    expect(noB.outcome).to.equal("No");
    // Buying YES raises the YES price; the subsequent NO buy lowers it again.
    expect(Number(yesA.price_yes_after)).to.be.greaterThan(500_000);
    expect(Number(noB.price_yes_after)).to.be.lessThan(
      Number(yesA.price_yes_after),
    );
  });

  it("decodes the winner and loser redemptions differently", () => {
    const winner = decodeLabel("redeem_winner_a")[0]!.data as unknown as Record<string, unknown>;
    const loser = decodeLabel("redeem_loser_b")[0]!.data as unknown as Record<string, unknown>;

    // chai's numeric comparisons do not accept bigint, so compare as strings
    // for equality and as Numbers for magnitude — payouts here are far under
    // 2^53, and the wire format keeps the exact value regardless.
    expect(Number(winner.payout as string)).to.be.greaterThan(0);
    expect(loser.payout).to.equal("0");
    // A loser still closes out and reclaims rent — that is the point of
    // clearing both sides rather than erroring.
    expect(loser.position_closed).to.equal(true);
    expect(winner.position_closed).to.equal(true);
  });

  it("ignores logs from unrelated programs", () => {
    const batch: LogBatch = {
      signature: "unrelated",
      slot: 1,
      blockTime: 0,
      logs: [
        "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]",
        "Program log: Instruction: Transfer",
        "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
        "Program 11111111111111111111111111111111 invoke [1]",
        "Program 11111111111111111111111111111111 success",
      ],
      failed: false,
    };
    expect(decoder.decode(batch)).to.deep.equal([]);
  });

  it("drops events from failed transactions", () => {
    // A reverted transaction still emits logs, and those can contain `emit!`
    // output from before the revert. Indexing it would invent state.
    const good = byLabel("buy_yes_a");
    const reverted: LogBatch = { ...toBatch(good), failed: true };
    expect(decoder.decode(reverted)).to.deep.equal([]);
    expect(decoder.decode(toBatch(good))).to.have.length.greaterThan(0);
  });

  it("survives malformed and empty logs without throwing", () => {
    const cases: LogBatch[] = [
      { signature: "a", slot: 1, blockTime: null, logs: [], failed: false },
      { signature: "b", slot: 1, blockTime: null, logs: ["garbage"], failed: false },
      {
        signature: "c",
        slot: 1,
        blockTime: null,
        logs: ["Program data: !!!not-base64!!!"],
        failed: false,
      },
      {
        signature: "d",
        slot: 1,
        blockTime: null,
        logs: ["Program data: AAAAAAAAAAA="], // valid base64, unknown discriminator
        failed: false,
      },
    ];
    for (const c of cases) {
      expect(() => decoder.decode(c), `case ${c.signature}`).to.not.throw();
    }
  });

  it("reports skips instead of failing silently", () => {
    const skips: string[] = [];
    const noisy = new Decoder({ onSkipped: (reason) => skips.push(reason) });
    const events = noisy.decode({
      signature: "x",
      slot: 1,
      blockTime: null,
      logs: ["Program data: AAAAAAAAAAA="],
      failed: false,
    });
    // Anchor rejects this with "Unexpected first log line". The contract is
    // that it surfaces as a skip rather than an exception or silent emptiness.
    expect(events).to.deep.equal([]);
    expect(skips).to.have.length.greaterThan(0);
    expect(skips.join(" ")).to.match(/parseLogs failed/);
  });

  it("keeps events decoded before a malformed line in the same transaction", () => {
    // parseLogs is a generator: a throw mid-iteration kills it. Events already
    // yielded must survive, or one stray line silently discards real trades.
    const good = byLabel("buy_yes_a");
    const skips: string[] = [];
    const decoderWithNoise = new Decoder({ onSkipped: (r) => skips.push(r) });

    const clean = decoderWithNoise.decode(toBatch(good));
    const withTrailingGarbage = decoderWithNoise.decode({
      ...toBatch(good),
      logs: [...good.logs, "Program data: AAAAAAAAAAA="],
    });

    expect(clean.length).to.be.greaterThan(0);
    expect(withTrailingGarbage.length).to.equal(clean.length);
  });
});
