#!/usr/bin/env node
/**
 * Entry point.
 *
 *   greekbet-indexer --endpoint https://api.devnet.solana.com \
 *                    --out ./data/events.jsonl \
 *                    --checkpoint ./data/checkpoint.json
 *
 * When `MONGODB_URI` is set (from the environment or repo `.env.local`), events
 * are also upserted to Atlas `chain_events` so Vercel can project the same
 * stream. Checkpoint stays on local disk — only the indexer process needs it.
 */

import * as fs from "fs";
import * as path from "path";

import { MongoClient } from "mongodb";
import { PublicKey } from "@solana/web3.js";

import { Indexer, consoleLogger } from "./indexer";
import { JsonlOutput } from "./output/jsonl";
import { MongoOutput } from "./output/mongo";
import { MultiOutput } from "./output/multi";
import type { OutputAdapter } from "./output/adapter";
import { PROGRAM_ID } from "./decoder";
import type { ParsedEvent } from "./types";

interface Args {
  endpoint: string;
  out: string;
  checkpoint: string;
  programId: string;
  noHydrate: boolean;
  mongoOnly: boolean;
}

/** Load key=value lines without overriding already-set process.env. */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function loadEnvFiles(): void {
  const candidates = [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), "..", ".env.local"),
    path.resolve(__dirname, "..", "..", ".env.local"),
    path.resolve(__dirname, "..", ".env.local"),
  ];
  for (const file of candidates) loadDotEnv(file);
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag);
    if (i === -1) return fallback;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return v;
  };

  return {
    endpoint: get(
      "--endpoint",
      process.env.RPC_URL ?? "https://api.devnet.solana.com",
    ),
    out: get("--out", "./data/events.jsonl"),
    checkpoint: get("--checkpoint", "./data/checkpoint.json"),
    programId: get("--program-id", PROGRAM_ID.toBase58()),
    noHydrate: argv.includes("--no-hydrate"),
    mongoOnly: argv.includes("--mongo-only"),
  };
}

function buildOutput(args: Args): OutputAdapter {
  const uri = process.env.MONGODB_URI?.trim();
  const jsonl = new JsonlOutput({ filePath: args.out });

  if (!uri) {
    consoleLogger.warn(
      "MONGODB_URI unset — writing JSONL only (Vercel will not see these events)",
    );
    return jsonl;
  }

  const mongo = new MongoOutput({
    uri,
    dbName: process.env.MONGODB_DB?.trim() || "greekbet",
  });

  if (args.mongoOnly) return mongo;
  return new MultiOutput([mongo, jsonl]);
}

async function seedMongoFromJsonl(
  uri: string,
  dbName: string,
  jsonlPath: string,
): Promise<number> {
  if (!fs.existsSync(jsonlPath)) return 0;
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 12_000,
  });
  try {
    await client.connect();
    const col = client.db(dbName).collection<ParsedEvent & { _id: string }>(
      "chain_events",
    );
    if ((await col.estimatedDocumentCount()) > 0) return 0;

    const lines = fs.readFileSync(jsonlPath, "utf8").split("\n");
    const docs: Array<ParsedEvent & { _id: string }> = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as ParsedEvent;
        docs.push({ _id: `${ev.signature}:${ev.event_index}`, ...ev });
      } catch {
        // skip torn lines
      }
    }
    if (docs.length === 0) return 0;
    const chunk = 500;
    for (let i = 0; i < docs.length; i += chunk) {
      const slice = docs.slice(i, i + chunk);
      await col.bulkWrite(
        slice.map((doc) => ({
          updateOne: {
            filter: { _id: doc._id },
            update: { $set: doc },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
    return docs.length;
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  loadEnvFiles();
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "greekbet-indexer — parse GroupBet program events into a stream",
        "",
        "  --endpoint <url>      RPC endpoint (env RPC_URL, default devnet)",
        "  --out <path>          output JSONL (default ./data/events.jsonl)",
        "  --checkpoint <path>   checkpoint file (default ./data/checkpoint.json)",
        "  --program-id <pubkey> override the bundled IDL's program id",
        "  --no-hydrate          skip the extra getTransaction per live event;",
        "                        faster and lighter on rate limits, but live",
        "                        events then carry block_time: null",
        "  --mongo-only          write Atlas only (skip JSONL) when MONGODB_URI set",
        "",
        "If MONGODB_URI is set (env or repo .env.local), events are upserted to",
        "the chain_events collection so the Vercel app can project them.",
        "An empty collection is seeded once from the existing JSONL file.",
      ].join("\n"),
    );
    return;
  }

  const args = parseArgs(argv);
  const uri = process.env.MONGODB_URI?.trim();
  if (uri) {
    const seeded = await seedMongoFromJsonl(
      uri,
      process.env.MONGODB_DB?.trim() || "greekbet",
      args.out,
    );
    if (seeded > 0) {
      consoleLogger.info("seeded Mongo from JSONL", { events: seeded });
    }
  }

  const output = buildOutput(args);

  const indexer = new Indexer({
    endpoint: args.endpoint,
    programId: new PublicKey(args.programId),
    checkpointPath: args.checkpoint,
    output,
    hydrateLiveEvents: !args.noHydrate,
    logger: consoleLogger,
  });

  // Stop cleanly on Ctrl-C so the checkpoint is flushed; otherwise the next run
  // replays from the last successful batch, which is correct but noisier.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    consoleLogger.info(`received ${signal}, stopping`);
    await indexer.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  consoleLogger.info("starting", {
    endpoint: args.endpoint,
    programId: args.programId,
    out: output.name,
  });
  await indexer.start();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
