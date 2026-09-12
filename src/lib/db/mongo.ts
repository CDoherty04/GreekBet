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

async function connect(): Promise<Db> {
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
      .collection("world_nullifiers")
      .createIndex({ action: 1, nullifier: 1 }, { unique: true }),
  ]);
  return db;
}

/** Shared Mongo handle (cached across hot reloads / warm lambdas). */
export async function getMongo(): Promise<Db> {
  globalForMongo.__greekbetMongo ??= connect();
  return globalForMongo.__greekbetMongo;
}
