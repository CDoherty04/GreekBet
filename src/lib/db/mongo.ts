/**
 * MongoDB connection for durable off-chain state (users, groups, markets).
 *
 * Required on Vercel — the old `.data/app-store.json` is ephemeral per instance.
 * Set `MONGODB_URI` (Atlas free tier is fine).
 */

import "server-only";

import { MongoClient, type Db } from "mongodb";

const globalForMongo = globalThis as unknown as {
  __greekbetMongo?: Promise<Db>;
};

function uri(): string {
  const u = process.env.MONGODB_URI?.trim();
  if (!u) {
    throw new Error(
      "MONGODB_URI is not set. Add it to .env.local (and Vercel) — e.g. mongodb+srv://… from Atlas.",
    );
  }
  return u;
}

function dbName(): string {
  return process.env.MONGODB_DB?.trim() || "greekbet";
}

function friendlyMongoError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    /tlsv1 alert internal error|ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR|SSL alert number 80/i.test(
      msg,
    )
  ) {
    return new Error(
      "MongoDB Atlas blocked the TLS connection (often IP allowlist). In Atlas → Network Access, allow your IP or 0.0.0.0/0 for demos, then retry.",
    );
  }
  if (/ECONNREFUSED|ENOTFOUND|querySrv|Server selection timed out/i.test(msg)) {
    return new Error(
      `MongoDB unreachable — check MONGODB_URI / Atlas Network Access. (${msg.slice(0, 120)})`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

async function connect(): Promise<Db> {
  try {
    const client = new MongoClient(uri(), {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8_000,
    });
    await client.connect();
    const db = client.db(dbName());
    await Promise.all([
      db.collection("users").createIndex({ phone: 1 }),
      db.collection("users").createIndex({ walletAddress: 1 }),
      db.collection("groups").createIndex({ code: 1 }, { unique: true }),
      db.collection("groups").createIndex({ memberIds: 1 }),
      db.collection("markets").createIndex({ groupId: 1 }),
      db
        .collection("chain_events")
        .createIndex({ signature: 1, event_index: 1 }, { unique: true }),
      db
        .collection("chain_events")
        .createIndex({ slot: 1, signature: 1, event_index: 1 }),
      db.collection("chain_events").createIndex({ market: 1 }),
    ]);
    return db;
  } catch (err) {
    // Drop the cached promise so the next request can retry after Atlas ACL fixes.
    globalForMongo.__greekbetMongo = undefined;
    throw friendlyMongoError(err);
  }
}

/** Shared Mongo handle (cached across hot reloads / warm lambdas). */
export async function getMongo(): Promise<Db> {
  try {
    globalForMongo.__greekbetMongo ??= connect();
    return await globalForMongo.__greekbetMongo;
  } catch (err) {
    globalForMongo.__greekbetMongo = undefined;
    throw err;
  }
}
