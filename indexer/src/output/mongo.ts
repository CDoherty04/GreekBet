/**
 * MongoDB output — shared sink for Vercel + a laptop/Railway indexer.
 *
 * Upserts by `(signature, event_index)` so reconnect/backfill is idempotent
 * and a failed checkpoint after a successful write does not duplicate rows.
 */

import { MongoClient, type Collection, type Db } from "mongodb";

import type { ParsedEvent } from "../types";
import type { OutputAdapter } from "./adapter";

export interface MongoOutputOptions {
  uri: string;
  dbName?: string;
  collection?: string;
}

type EventDoc = ParsedEvent & { _id: string };

export class MongoOutput implements OutputAdapter {
  readonly name: string;
  private client: MongoClient | null = null;
  private col: Collection<EventDoc> | null = null;
  private _written = 0;

  constructor(private readonly options: MongoOutputOptions) {
    const db = options.dbName ?? "greekbet";
    const coll = options.collection ?? "chain_events";
    this.name = `mongo(${db}.${coll})`;
  }

  async open(): Promise<void> {
    if (this.col) return;
    this.client = new MongoClient(this.options.uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 12_000,
    });
    await this.client.connect();
    const db: Db = this.client.db(this.options.dbName ?? "greekbet");
    this.col = db.collection<EventDoc>(
      this.options.collection ?? "chain_events",
    );
    await Promise.all([
      this.col.createIndex(
        { signature: 1, event_index: 1 },
        { unique: true },
      ),
      this.col.createIndex({ slot: 1, signature: 1, event_index: 1 }),
      this.col.createIndex({ market: 1 }),
    ]);
  }

  async emit(events: ParsedEvent[]): Promise<void> {
    if (events.length === 0) return;
    if (!this.col) throw new Error("MongoOutput.emit before open()");

    const ops = events.map((ev) => {
      const _id = `${ev.signature}:${ev.event_index}`;
      const doc: EventDoc = { _id, ...ev };
      return {
        updateOne: {
          filter: { _id },
          update: { $set: doc },
          upsert: true,
        },
      };
    });

    await this.col.bulkWrite(ops, { ordered: true });
    this._written += events.length;
  }

  async close(): Promise<void> {
    if (!this.client) return;
    await this.client.close();
    this.client = null;
    this.col = null;
  }

  get written(): number {
    return this._written;
  }
}
