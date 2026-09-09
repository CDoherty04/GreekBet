/**
 * Raw transaction logs → typed, normalized {@link ParsedEvent}s.
 *
 * ## Why the IDL is bundled, not fetched
 *
 * The plan (§3.1) says to decode with "the Anchor IDL (generated from the
 * program)". There are two copies of that IDL and **only the local one works**.
 *
 * Anchor 1.2's `deploy` also uploads the IDL to an on-chain program-metadata
 * account; for this program that upload failed partway (it is why `anchor
 * deploy` exited 1 *after* successfully deploying the binary). `anchor idl
 * fetch` returns raw zlib and the document is incomplete. So this module loads
 * `idl/greekbet.json` from disk, committed alongside the code.
 *
 * Bundling is the better choice regardless: it removes an RPC round-trip from
 * startup, and it pins decoding to a known IDL version rather than whatever
 * happens to be on chain — which can drift from the deployed binary.
 */

import { BorshCoder, EventParser } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";

import {
  EVENT_TYPES,
  type EventType,
  type LogBatch,
  type ParsedEvent,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const IDL = require("../idl/greekbet.json");

const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);

/** Program id the bundled IDL was generated for. */
export const PROGRAM_ID: PublicKey = new PublicKey(IDL.address);

/**
 * Anchor decodes a unit enum variant as `{ yes: {} }` / `{ no: {} }`.
 * The wire format wants `"Yes"` / `"No"`.
 */
function outcomeToString(value: unknown): "Yes" | "No" {
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    const key = keys[0]?.toLowerCase();
    if (key === "yes") return "Yes";
    if (key === "no") return "No";
  }
  throw new DecodeError(`unrecognised Outcome variant: ${JSON.stringify(value)}`);
}

/**
 * `BN | bigint | number` → decimal string. See {@link U64String} for why this is
 * a string and not a JSON number.
 *
 * All three inputs accept a radix on `toString`, and passing 10 explicitly
 * matters: `BN.toString()` defaults to base 10 but a bare `Number.toString()` on
 * a very large value can produce exponential notation, which would not round
 * trip through a consumer expecting digits.
 */
function u64(value: unknown): string {
  if (value === null || value === undefined) {
    throw new DecodeError("missing u64 field");
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new DecodeError(`u64 arrived as an unsafe number: ${value}`);
    }
    return value.toString(10);
  }
  if (typeof value === "bigint") return value.toString(10);
  const asBn = value as { toString(radix?: number): string };
  if (typeof asBn.toString !== "function") {
    throw new DecodeError(`cannot stringify u64 of type ${typeof value}`);
  }
  return asBn.toString(10);
}

/** `i64` timestamp → number. Safe: seconds since epoch is far under 2^53. */
function i64Num(value: unknown): number {
  const n = Number((value as { toString(): string }).toString());
  if (!Number.isFinite(n)) throw new DecodeError("non-finite i64");
  return n;
}

function pubkey(value: unknown): string {
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value === "string") return value;
  throw new DecodeError(`expected pubkey, got ${typeof value}`);
}

/** `[u8; 32]` → lowercase hex. */
function hex32(value: unknown): string {
  const bytes = value as ArrayLike<number>;
  if (!bytes || typeof bytes.length !== "number") {
    throw new DecodeError("expected byte array");
  }
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return out;
}

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

/**
 * Turn one Anchor event's fields into this indexer's wire shape.
 *
 * Field names are remapped deliberately rather than passed through: the program
 * calls the trader `buyer` on one event and `seller` on the other, and names the
 * amounts `collateral_in`/`shares_out` versus `shares_in`/`collateral_out`. A
 * consumer should not have to branch on event type to find who traded, so both
 * collapse onto `user` / `collateral` / `shares` with `is_buy` carrying the
 * direction — which is the unified view the original plan asked for.
 */
function normalizeData(name: EventType, f: Record<string, unknown>): unknown {
  switch (name) {
    case "MarketCreated":
      return {
        creator: pubkey(f.creator),
        resolver: pubkey(f.resolver),
        collateral_mint: pubkey(f.collateralMint ?? f.collateral_mint),
        vault: pubkey(f.vault),
        question_hash: hex32(f.questionHash ?? f.question_hash),
        b: u64(f.b),
        seed_amount: u64(f.seedAmount ?? f.seed_amount),
        created_at: i64Num(f.createdAt ?? f.created_at),
        close_time: i64Num(f.closeTime ?? f.close_time),
      };

    case "SharesBought":
      return {
        is_buy: true,
        user: pubkey(f.buyer),
        outcome: outcomeToString(f.outcome),
        collateral: u64(f.collateralIn ?? f.collateral_in),
        shares: u64(f.sharesOut ?? f.shares_out),
        avg_price: u64(f.avgPricePaid ?? f.avg_price_paid),
        ...commonTradeFields(f),
      };

    case "SharesSold":
      return {
        is_buy: false,
        user: pubkey(f.seller),
        outcome: outcomeToString(f.outcome),
        collateral: u64(f.collateralOut ?? f.collateral_out),
        shares: u64(f.sharesIn ?? f.shares_in),
        avg_price: u64(f.avgPriceReceived ?? f.avg_price_received),
        ...commonTradeFields(f),
      };

    case "MarketClosed":
      return {
        close_time: i64Num(f.closeTime ?? f.close_time),
        closed_at: i64Num(f.closedAt ?? f.closed_at),
        q_yes: u64(f.qYes ?? f.q_yes),
        q_no: u64(f.qNo ?? f.q_no),
      };

    case "MarketResolved":
      return {
        resolver: pubkey(f.resolver),
        winning_outcome: outcomeToString(f.winningOutcome ?? f.winning_outcome),
        resolved_at: i64Num(f.resolvedAt ?? f.resolved_at),
        q_yes: u64(f.qYes ?? f.q_yes),
        q_no: u64(f.qNo ?? f.q_no),
      };

    case "Redeemed":
      return {
        owner: pubkey(f.owner),
        winning_outcome: outcomeToString(f.winningOutcome ?? f.winning_outcome),
        winning_shares: u64(f.winningShares ?? f.winning_shares),
        losing_shares: u64(f.losingShares ?? f.losing_shares),
        payout: u64(f.payout),
        position_closed: Boolean(f.positionClosed ?? f.position_closed),
      };
  }
}

function commonTradeFields(f: Record<string, unknown>) {
  return {
    q_yes_before: u64(f.qYesBefore ?? f.q_yes_before),
    q_no_before: u64(f.qNoBefore ?? f.q_no_before),
    q_yes_after: u64(f.qYesAfter ?? f.q_yes_after),
    q_no_after: u64(f.qNoAfter ?? f.q_no_after),
    price_yes_after: u64(f.priceYesAfter ?? f.price_yes_after),
    position_yes_shares: u64(f.positionYesShares ?? f.position_yes_shares),
    position_no_shares: u64(f.positionNoShares ?? f.position_no_shares),
  };
}

export interface DecoderOptions {
  /**
   * Called when a log batch contains something event-shaped that cannot be
   * decoded. Default: ignore.
   *
   * These are not fatal. A block routinely contains logs from unrelated
   * programs, and a future program version may emit events this IDL predates —
   * neither should stop the indexer.
   */
  onSkipped?: (reason: string, batch: LogBatch) => void;
}

export class Decoder {
  private readonly parser: EventParser;
  private readonly onSkipped: (reason: string, batch: LogBatch) => void;

  constructor(options: DecoderOptions = {}) {
    this.parser = new EventParser(PROGRAM_ID, new BorshCoder(IDL));
    this.onSkipped = options.onSkipped ?? (() => {});
  }

  /**
   * Decode one transaction's logs.
   *
   * Returns events in emission order, each stamped with `event_index`. Events
   * from other programs in the same transaction are ignored — `EventParser` is
   * scoped to this program id, so logs from an unrelated program in the same
   * block never reach the coder.
   */
  decode(batch: LogBatch): ParsedEvent[] {
    // A failed transaction still emits logs, and those logs can contain `emit!`
    // output produced before the revert. Nothing in a reverted transaction
    // happened, so indexing it would invent state that does not exist on chain.
    if (batch.failed) return [];
    if (!batch.logs || batch.logs.length === 0) return [];

    const out: ParsedEvent[] = [];
    let index = 0;

    // `parseLogs` returns a GENERATOR, so it throws while being iterated, not
    // when called — Anchor raises "Unexpected first log line" on anything it
    // cannot make sense of. Wrapping only the call therefore catches nothing,
    // and one malformed line from an unrelated program would take the whole
    // indexer down. The iteration itself has to be guarded.
    //
    // A throw kills the generator, so events already yielded are kept and the
    // remainder of that transaction is abandoned. Partial output beats none:
    // the alternative is dropping valid, already-decoded events.
    try {
      const iterable = this.parser.parseLogs(batch.logs) as Iterable<{
        name: string;
        data: Record<string, unknown>;
      }>;

      for (const ev of iterable) {
        // Anchor's casing has varied across versions; normalise to the IDL's
        // PascalCase before matching.
        const name = ev.name.charAt(0).toUpperCase() + ev.name.slice(1);
        if (!EVENT_TYPE_SET.has(name)) {
          this.onSkipped(`unknown event ${ev.name}`, batch);
          continue;
        }
        const typed = name as EventType;

        try {
          const data = normalizeData(typed, ev.data) as ParsedEvent["data"];
          out.push({
            event_type: typed,
            market: pubkey(ev.data.market),
            slot: batch.slot,
            signature: batch.signature,
            event_index: index++,
            block_time: batch.blockTime,
            data,
          });
        } catch (err) {
          // One malformed event must not discard its siblings.
          this.onSkipped(
            `failed to normalize ${name}: ${(err as Error).message}`,
            batch,
          );
        }
      }
    } catch (err) {
      this.onSkipped(`parseLogs failed: ${(err as Error).message}`, batch);
    }

    return out;
  }
}
