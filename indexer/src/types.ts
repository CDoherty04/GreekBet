/**
 * The indexer's public data contract.
 *
 * This is the shape a downstream database writer consumes. Persistence is
 * deliberately out of scope here (see the plan, §4) — the indexer's product is
 * a stream of these objects, nothing more.
 *
 * The wire format is **snake_case**, matching the plan's §3.1 sketch, because a
 * separate consumer is being written against that spec. Internal identifiers
 * stay camelCase; the conversion happens once, at the edge, in `decoder.ts`.
 */

/** The six events the deployed program actually emits. */
export const EVENT_TYPES = [
  "MarketCreated",
  "SharesBought",
  "SharesSold",
  "MarketClosed",
  "MarketResolved",
  "Redeemed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Note for anyone holding the original plan: it assumed a single
 * `SharesTraded { is_buy: bool }` and a `SharesRedeemed`. The program instead
 * emits **`SharesBought`** and **`SharesSold`** as distinct events, and calls
 * redemption **`Redeemed`**. The program is deployed and its keypair exists on
 * one machine, so it is not worth a redeploy to rename events — the indexer
 * carries the difference instead, which is the cheaper and more reversible
 * side to put it on.
 *
 * Consumers that want the plan's unified view can derive it: `SharesBought` and
 * `SharesSold` both populate {@link TradeData}, and `is_buy` is recoverable
 * from `event_type`.
 */
export interface ParsedEvent<T = EventData> {
  event_type: EventType;
  /** Market PDA, base58. Present on every event — it is the natural partition key. */
  market: string;
  slot: number;
  signature: string;
  /**
   * Index of this event within its transaction, starting at 0.
   *
   * `signature` alone is **not** a unique key: one transaction can contain
   * several instructions and therefore several events. `(signature,
   * event_index)` is the idempotency key the downstream writer should use, and
   * it is what {@link Deduplicator} filters on.
   */
  event_index: number;
  /** Unix seconds. `null` when the RPC has not yet attached one to the block. */
  block_time: number | null;
  data: T;
}

/**
 * All `u64` values are **decimal strings**, never JSON numbers.
 *
 * Share quantities reach `1e15` and collateral is in 6-decimal base units. That
 * is under `Number.MAX_SAFE_INTEGER` today, but only by a factor of nine, and a
 * `u64` is not bounded by the program's current limits — a JSON number would
 * silently lose precision at the top of the range with no error anywhere. The
 * reference vectors made the same choice for the same reason.
 *
 * `i64` timestamps and slots stay numbers: they are small, and they are used
 * for ordering and display where a string would be actively unhelpful.
 */
export type U64String = string;

export interface MarketCreatedData {
  creator: string;
  resolver: string;
  collateral_mint: string;
  vault: string;
  /** SHA-256 of the question's raw UTF-8 bytes, hex. Third seed of the market PDA. */
  question_hash: string;
  b: U64String;
  /** Collateral the creator deposited: `C(0,0) = b·ln2`, the LMSR max subsidy. */
  seed_amount: U64String;
  created_at: number;
  close_time: number;
}

/** Shared by `SharesBought` and `SharesSold`; `is_buy` distinguishes them. */
export interface TradeData {
  is_buy: boolean;
  /** Buyer or seller, base58. */
  user: string;
  outcome: "Yes" | "No";
  /** Collateral base units in (buy) or out (sell). */
  collateral: U64String;
  /** Share base units out (buy) or in (sell). */
  shares: U64String;
  /** Realised average price for this trade, as a fraction of 1e6. */
  avg_price: U64String;
  q_yes_before: U64String;
  q_no_before: U64String;
  q_yes_after: U64String;
  q_no_after: U64String;
  /**
   * Marginal YES price after the trade, as a fraction of 1e6.
   *
   * Only obtainable from the event — the `Market` account stores `q_yes`/`q_no`
   * but not price. Anything reconstructing a price history needs these events;
   * account snapshots alone are not sufficient.
   */
  price_yes_after: U64String;
  position_yes_shares: U64String;
  position_no_shares: U64String;
}

export interface MarketClosedData {
  close_time: number;
  closed_at: number;
  q_yes: U64String;
  q_no: U64String;
}

export interface MarketResolvedData {
  resolver: string;
  winning_outcome: "Yes" | "No";
  resolved_at: number;
  q_yes: U64String;
  q_no: U64String;
}

export interface RedeemedData {
  owner: string;
  winning_outcome: "Yes" | "No";
  winning_shares: U64String;
  losing_shares: U64String;
  /** Collateral paid out, 1:1 with winning shares. Zero for a pure loser. */
  payout: U64String;
  /** `redeem` closes the position account, so this is true on the happy path. */
  position_closed: boolean;
}

export type EventData =
  | MarketCreatedData
  | TradeData
  | MarketClosedData
  | MarketResolvedData
  | RedeemedData;

/** A transaction's logs plus the metadata every parsed event is stamped with. */
export interface LogBatch {
  signature: string;
  slot: number;
  blockTime: number | null;
  logs: string[];
  /**
   * True when the transaction failed on chain.
   *
   * Failed transactions still produce logs, and those logs can contain `emit!`
   * output from before the revert. Nothing in them happened, so the decoder
   * drops them — see `decoder.ts`.
   */
  failed?: boolean;
}
