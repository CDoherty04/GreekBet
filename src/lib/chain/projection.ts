/**
 * The indexer's event stream, folded into the state the UI renders.
 *
 * This is the consumer the indexer plan left deliberately unbuilt: the indexer
 * emits parsed events to JSONL and something else persists or projects them.
 * This is that something else — an in-memory projection, rebuilt by replaying
 * the file.
 *
 * ## Why events rather than reading accounts
 *
 * Chiefly because **price is not stored on chain**. The `Market` account holds
 * `q_yes`/`q_no` but no price, so `price_yes_after` exists only in the trade
 * events. Any odds display or price history has to come from the stream;
 * account snapshots cannot produce it.
 *
 * Replaying is also cheap and self-healing: the file is append-only and the
 * events are already deduplicated and slot-ordered, so a fold is total and
 * order-independent bugs cannot creep in from partial updates.
 *
 * ## What this is not
 *
 * Not durable, and not a database. The projection is rebuilt from the JSONL on
 * demand and cached briefly. That is the right shape while the file is small;
 * a real deployment would have the indexer write to Postgres and this module
 * would query it instead. The interface below would not change.
 */

import "server-only";

import * as fs from "fs";
import * as path from "path";

import { UNIT } from "./config";

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

interface Cached {
  markets: Map<string, ChainMarket>;
  mtimeMs: number;
  size: number;
}

const globalForProjection = globalThis as unknown as {
  __greekbetProjection?: Cached;
};

/**
 * Read the stream and fold it.
 *
 * Cached against the file's mtime and size so a request that changes nothing
 * does not re-read the file, while an append is picked up immediately.
 */
export function projection(): Map<string, ChainMarket> {
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

  const cached = globalForProjection.__greekbetProjection;
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.markets;
  }

  const markets = new Map<string, ChainMarket>();
  const raw = fs.readFileSync(/* turbopackIgnore: true */ EVENTS_FILE, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      apply(markets, JSON.parse(line) as RawEvent);
    } catch {
      // A torn final line is normal while the indexer is mid-append. Skipping
      // it costs one event that the next read will pick up.
    }
  }

  globalForProjection.__greekbetProjection = {
    markets,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
  return markets;
}

export function getChainMarket(address: string): ChainMarket | undefined {
  return projection().get(address);
}

export function positionFor(
  market: ChainMarket | undefined,
  wallet: string | undefined,
): ChainPosition | undefined {
  if (!market || !wallet) return undefined;
  return market.positions[wallet];
}

/** Where the stream is read from, for diagnostics. */
export const eventsFilePath = EVENTS_FILE;
