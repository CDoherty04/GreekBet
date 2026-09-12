/**
 * The indexer's event stream, folded into the state the UI renders.
 *
 * Prefer MongoDB `chain_events` when `MONGODB_URI` is set (Vercel + a remote
 * indexer). Fall back to the local JSONL file for offline demos.
 *
 * ## Why events rather than reading accounts
 *
 * Chiefly because **price is not stored on chain**. The `Market` account holds
 * `q_yes`/`q_no` but no price, so `price_yes_after` exists only in the trade
 * events. Any odds display or price history has to come from the stream;
 * account snapshots cannot produce it.
 */

import "server-only";

import * as fs from "fs";
import * as path from "path";

import { UNIT } from "./config";
import { getMongo } from "@/lib/db/mongo";

/** Mirrors the indexer's wire format (`indexer/src/types.ts`). */
interface RawEvent {
  event_type:
    | "MarketCreated"
    | "SharesBought"
    | "SharesSold"
    | "MarketClosed"
    | "MarketResolved"
    | "Redeemed";
  market: string;
  slot: number;
  signature: string;
  event_index: number;
  block_time: number | null;
  data: Record<string, unknown>;
}

export type ChainMarketStatus = "open" | "closed" | "resolved";

export interface ChainTrade {
  signature: string;
  slot: number;
  blockTime: number | null;
  user: string;
  outcome: "yes" | "no";
  isBuy: boolean;
  /** Base units, as strings — shares reach 1e15. */
  collateral: string;
  shares: string;
  priceYesAfter: string;
}

export interface ChainPosition {
  owner: string;
  yesShares: string;
  noShares: string;
  /** Set once the holder has redeemed. */
  payout?: string;
  redeemed: boolean;
}

export interface ChainMarket {
  address: string;
  creator: string;
  resolver: string;
  collateralMint: string;
  vault: string;
  questionHash: string;
  b: string;
  seedAmount: string;
  createdAt: number;
  closeTime: number;
  status: ChainMarketStatus;
  winningOutcome?: "yes" | "no";
  qYes: string;
  qNo: string;
  /** Marginal YES price, fraction of 1e6. 500000 (50%) before any trade. */
  priceYes: string;
  trades: ChainTrade[];
  positions: Record<string, ChainPosition>;
  /** Collateral currently held by the vault, base units. */
  volume: string;
}

const EVENTS_FILE =
  process.env.GREEKBET_EVENTS_FILE ??
  path.join(process.cwd(), "indexer", "data", "events.jsonl");

function emptyPosition(owner: string): ChainPosition {
  return { owner, yesShares: "0", noShares: "0", redeemed: false };
}

/**
 * Fold one event into the projection.
 *
 * Every branch is idempotent in the sense that replaying the whole file from
 * scratch yields the same result — the projection is never mutated
 * incrementally from a partial read.
 */
function apply(markets: Map<string, ChainMarket>, ev: RawEvent): void {
  const d = ev.data as Record<string, string & boolean>;

  if (ev.event_type === "MarketCreated") {
    markets.set(ev.market, {
      address: ev.market,
      creator: d.creator,
      resolver: d.resolver,
      collateralMint: d.collateral_mint,
      vault: d.vault,
      questionHash: d.question_hash,
      b: d.b,
      seedAmount: d.seed_amount,
      createdAt: Number(d.created_at),
      closeTime: Number(d.close_time),
      status: "open",
      qYes: "0",
      qNo: "0",
      // No trade yet, so the market is exactly even. The program would agree:
      // price_yes(0,0,b) is exactly UNIT/2 by construction.
      priceYes: String(UNIT / 2),
      trades: [],
      positions: {},
      volume: d.seed_amount,
    });
    return;
  }

  const m = markets.get(ev.market);
  // An event for a market we never saw created means the stream starts mid-life
  // (the file was truncated, or indexing began late). Dropping it is correct:
  // a partial market would render with missing terms and wrong odds.
  if (!m) return;

  switch (ev.event_type) {
    case "SharesBought":
    case "SharesSold": {
      const isBuy = ev.event_type === "SharesBought";
      const user = d.user;
      m.qYes = d.q_yes_after;
      m.qNo = d.q_no_after;
      m.priceYes = d.price_yes_after;
      m.trades.push({
        signature: ev.signature,
        slot: ev.slot,
        blockTime: ev.block_time,
        user,
        outcome: d.outcome === "Yes" ? "yes" : "no",
        isBuy,
        collateral: d.collateral,
        shares: d.shares,
        priceYesAfter: d.price_yes_after,
      });

      // The event carries the holder's post-trade position, so this is read
      // from chain rather than accumulated — no drift is possible.
      const pos = m.positions[user] ?? emptyPosition(user);
      pos.yesShares = d.position_yes_shares;
      pos.noShares = d.position_no_shares;
      m.positions[user] = pos;

      const vol = BigInt(m.volume);
      m.volume = (isBuy ? vol + BigInt(d.collateral) : vol - BigInt(d.collateral)).toString();
      return;
    }

    case "MarketClosed":
      m.status = "closed";
      m.qYes = d.q_yes;
      m.qNo = d.q_no;
      return;

    case "MarketResolved":
      m.status = "resolved";
      m.winningOutcome = d.winning_outcome === "Yes" ? "yes" : "no";
      m.qYes = d.q_yes;
      m.qNo = d.q_no;
      return;

    case "Redeemed": {
      const pos = m.positions[d.owner] ?? emptyPosition(d.owner);
      pos.payout = d.payout;
      pos.redeemed = true;
      // `redeem` clears both sides, winning and losing alike, which is what
      // makes a second redeem a no-op.
      pos.yesShares = "0";
      pos.noShares = "0";
      m.positions[d.owner] = pos;
      m.volume = (BigInt(m.volume) - BigInt(d.payout)).toString();
      return;
    }
  }
}

interface FileCached {
  markets: Map<string, ChainMarket>;
  mtimeMs: number;
  size: number;
}

interface MongoCached {
  markets: Map<string, ChainMarket>;
  at: number;
  count: number;
}

const MONGO_CACHE_MS = 1_500;

const globalForProjection = globalThis as unknown as {
  __greekbetProjectionFile?: FileCached;
  __greekbetProjectionMongo?: MongoCached;
};

function useMongo(): boolean {
  return Boolean(process.env.MONGODB_URI?.trim());
}

function foldEvents(events: RawEvent[]): Map<string, ChainMarket> {
  const markets = new Map<string, ChainMarket>();
  for (const ev of events) apply(markets, ev);
  return markets;
}

function projectionFromFile(): Map<string, ChainMarket> {
  let stat: fs.Stats;
  try {
    // turbopackIgnore: the path is configurable, so the bundler cannot prove it
    // is scoped to a subfolder and would otherwise trace the entire project
    // into the server bundle. Reading a runtime-configured file is the point of
    // this module.
    stat = fs.statSync(/* turbopackIgnore: true */ EVENTS_FILE);
  } catch {
    // No stream yet — the indexer has not run. An empty projection is correct
    // and lets the app render "no markets" rather than erroring.
    return new Map();
  }

  const cached = globalForProjection.__greekbetProjectionFile;
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.markets;
  }

  const events: RawEvent[] = [];
  const raw = fs.readFileSync(/* turbopackIgnore: true */ EVENTS_FILE, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as RawEvent);
    } catch {
      // A torn final line is normal while the indexer is mid-append. Skipping
      // it costs one event that the next read will pick up.
    }
  }

  const markets = foldEvents(events);
  globalForProjection.__greekbetProjectionFile = {
    markets,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
  return markets;
}

async function projectionFromMongo(): Promise<Map<string, ChainMarket>> {
  const db = await getMongo();
  const col = db.collection<RawEvent>("chain_events");
  const count = await col.estimatedDocumentCount();
  const cached = globalForProjection.__greekbetProjectionMongo;
  if (
    cached &&
    cached.count === count &&
    Date.now() - cached.at < MONGO_CACHE_MS
  ) {
    return cached.markets;
  }

  const events = await col
    .find({})
    .sort({ slot: 1, signature: 1, event_index: 1 })
    .toArray();

  const markets = foldEvents(events);
  globalForProjection.__greekbetProjectionMongo = {
    markets,
    at: Date.now(),
    count,
  };
  return markets;
}

/** Drop cached folds so the next read picks up newly indexed events. */
export function invalidateProjection(): void {
  globalForProjection.__greekbetProjectionFile = undefined;
  globalForProjection.__greekbetProjectionMongo = undefined;
}

/**
 * Read the stream and fold it.
 *
 * Mongo when `MONGODB_URI` is set; otherwise the local JSONL file.
 */
export async function projection(): Promise<Map<string, ChainMarket>> {
  if (useMongo()) return projectionFromMongo();
  return projectionFromFile();
}

export async function getChainMarket(
  address: string,
): Promise<ChainMarket | undefined> {
  return (await projection()).get(address);
}

export function positionFor(
  market: ChainMarket | undefined,
  wallet: string | undefined,
): ChainPosition | undefined {
  if (!market || !wallet) return undefined;
  return market.positions[wallet];
}

/** Where the local stream is read from, for diagnostics. */
export const eventsFilePath = EVENTS_FILE;
