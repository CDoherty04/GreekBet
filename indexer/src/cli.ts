#!/usr/bin/env node
/**
 * Entry point.
 *
 *   greekbet-indexer --endpoint https://api.devnet.solana.com \
 *                    --out ./data/events.jsonl \
 *                    --checkpoint ./data/checkpoint.json
 *
 * Defaults target devnet and the deployed program, so `npm start` with no
 * arguments does the useful thing.
 */

import { PublicKey } from "@solana/web3.js";

import { Indexer, consoleLogger } from "./indexer";
import { JsonlOutput } from "./output/jsonl";
import { PROGRAM_ID } from "./decoder";

interface Args {
  endpoint: string;
  out: string;
  checkpoint: string;
  programId: string;
  noHydrate: boolean;
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
    endpoint: get("--endpoint", process.env.RPC_URL ?? "https://api.devnet.solana.com"),
    out: get("--out", "./data/events.jsonl"),
    checkpoint: get("--checkpoint", "./data/checkpoint.json"),
    programId: get("--program-id", PROGRAM_ID.toBase58()),
    noHydrate: argv.includes("--no-hydrate"),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "greekbet-indexer — parse GreekBet program events into a JSONL stream",
        "",
        "  --endpoint <url>      RPC endpoint (env RPC_URL, default devnet)",
        "  --out <path>          output JSONL (default ./data/events.jsonl)",
        "  --checkpoint <path>   checkpoint file (default ./data/checkpoint.json)",
        "  --program-id <pubkey> override the bundled IDL's program id",
        "  --no-hydrate          skip the extra getTransaction per live event;",
        "                        faster and lighter on rate limits, but live",
        "                        events then carry block_time: null",
      ].join("\n"),
    );
    return;
  }

  const args = parseArgs(argv);
  const output = new JsonlOutput({ filePath: args.out });

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
    out: args.out,
  });
  await indexer.start();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
