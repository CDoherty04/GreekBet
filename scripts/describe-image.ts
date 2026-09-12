/**
 * Run resolver stage 1 (describe) against a local photo, without the camera UI.
 *
 *   npm run describe -- <imagePath> "<question>" [--context "<text>"] [--json]
 *
 * Loads `.env*` files the same way `next dev` does, so `OPENAI_API_KEY` and
 * `OPENAI_VISION_MODEL` from `.env.local` are picked up. Without a key the
 * describe module returns a flagged stub (`stub: true`) in development.
 *
 * Exit codes: 0 ok · 1 describe/file error · 2 bad arguments.
 */

import * as fs from "fs";
import * as path from "path";

import { loadEnvConfig } from "@next/env";

import {
  DescribeError,
  describeImage,
  formatDescription,
} from "../src/lib/resolver/describe";

const USAGE =
  'usage: npm run describe -- <imagePath> "<question>" [--context "<text>"] [--json]';

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

interface Args {
  imagePath: string;
  question: string;
  context?: string;
  json: boolean;
}

function usage(problem?: string): never {
  if (problem) console.error(`error: ${problem}\n`);
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let context: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--context") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        usage("--context needs a value");
      }
      context = value;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("--")) {
      usage(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 2) {
    usage(
      positional.length < 2
        ? "missing <imagePath> and/or <question>"
        : "too many arguments (quote the question)",
    );
  }
  const [imagePath, question] = positional;
  if (!question.trim()) usage("<question> is empty");

  return { imagePath, question, context, json };
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function readAsDataUrl(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) {
    fail(
      `unsupported extension "${ext || "(none)"}" — use ${Object.keys(MIME_BY_EXT).join(", ")}`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(imagePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    fail(
      code === "ENOENT"
        ? `no such file: ${imagePath}`
        : code === "EISDIR"
          ? `not a file: ${imagePath}`
          : `cannot read ${imagePath}: ${err instanceof Error ? err.message : err}`,
    );
  }

  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Same env resolution as `next dev` (.env.local, .env.development, .env).
  loadEnvConfig(process.cwd(), true, { info: () => {}, error: console.error });

  const imageDataUrl = readAsDataUrl(args.imagePath);

  const started = Date.now();
  const result = await describeImage({
    imageDataUrl,
    question: args.question,
    context: args.context,
  });
  const elapsedMs = Date.now() - started;

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatDescription(result.description));
  console.log(
    `\nmodel=${result.model} responseId=${result.responseId ?? "null"} ` +
      `stub=${result.stub} elapsed=${elapsedMs}ms`,
  );
}

main().catch((err) => {
  if (err instanceof DescribeError) {
    console.error(`${err.code}: ${err.message}`);
  } else {
    console.error("failed:", err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
