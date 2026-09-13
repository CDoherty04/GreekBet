/**
 * Server-held Solana keypairs for **non-user** roles. **Server-only.**
 *
 * User wallets are Privy embedded Solana wallets — the app never holds those
 * secrets. This module only stores:
 *
 * * **resolver** — settles markets after AI / owner confirm
 * * **fee payer** — optional sponsor for resolver txs
 * * **agent trader** — Bazantic Recipe trades (sign + send without Privy UI)
 *
 * Locally, keys live in `.data/keypairs.json` (gitignored). On Vercel / any
 * read-only filesystem, set `GREEKBET_RESOLVER_SECRET` (and optionally
 * `GREEKBET_FEE_PAYER_SECRET` / `GREEKBET_AGENT_TRADER_SECRET`) to a JSON
 * array of secret-key bytes — never attempt to mkdir under `/var/task`.
 */

import "server-only";

import * as fs from "fs";
import * as path from "path";
import { Keypair } from "@solana/web3.js";

const KEY_FILE = path.join(process.cwd(), ".data", "keypairs.json");

type KeyStore = Record<string, number[]>;

/** True on Vercel / Lambda — local `.data` writes will fail. */
function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function load(): KeyStore {
  try {
    return JSON.parse(fs.readFileSync(KEY_FILE, "utf8")) as KeyStore;
  } catch {
    return {};
  }
}

function persist(store: KeyStore): void {
  if (isServerless()) {
    throw new Error(
      "Cannot write role keypairs on this host. Set GREEKBET_RESOLVER_SECRET (JSON byte array) in the environment.",
    );
  }
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    const tmp = `${KEY_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
    fs.renameSync(tmp, KEY_FILE);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: string }).code)
        : "";
    if (code === "ENOENT" || code === "EROFS" || code === "EACCES") {
      throw new Error(
        "Cannot write .data/keypairs.json. Set GREEKBET_RESOLVER_SECRET in the environment.",
      );
    }
    throw err;
  }
}

function fromEnvSecret(envName: string): Keypair | null {
  const raw = process.env[envName]?.trim();
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
  } catch {
    throw new Error(`${envName} must be a JSON array of secret-key bytes`);
  }
}

function keypairFor(role: string, envName: string): Keypair {
  const fromEnv = fromEnvSecret(envName);
  if (fromEnv) return fromEnv;

  if (isServerless()) {
    throw new Error(
      `${envName} is required on Vercel (JSON array of secret-key bytes). Local .data keypairs are not available in production.`,
    );
  }

  const store = load();
  const existing = store[role];
  if (existing) return Keypair.fromSecretKey(Uint8Array.from(existing));

  const kp = Keypair.generate();
  store[role] = Array.from(kp.secretKey);
  persist(store);
  return kp;
}

/** Local role keypair for scripts / resolver — not used for end-user wallets. */
export function roleKeypair(role: string): Keypair {
  if (isServerless()) {
    throw new Error(
      `roleKeypair(${role}) is not available on Vercel — use GREEKBET_RESOLVER_SECRET / GREEKBET_FEE_PAYER_SECRET / GREEKBET_AGENT_TRADER_SECRET`,
    );
  }
  const store = load();
  const existing = store[role];
  if (existing) return Keypair.fromSecretKey(Uint8Array.from(existing));

  const kp = Keypair.generate();
  store[role] = Array.from(kp.secretKey);
  persist(store);
  return kp;
}

/**
 * The resolver authority.
 *
 * One key for the whole deployment: markets are created with this as their
 * resolver, so the server can settle them once the AI reads the photo.
 */
export function resolverKeypair(): Keypair {
  return keypairFor("__resolver__", "GREEKBET_RESOLVER_SECRET");
}

/**
 * The fee payer for server-submitted transactions (e.g. resolution).
 *
 * Needs devnet SOL; without it resolution fails deep in the runtime.
 */
export function feePayerKeypair(): Keypair {
  return keypairFor("__fee_payer__", "GREEKBET_FEE_PAYER_SECRET");
}

/**
 * The agent trader for Bazantic Recipes.
 *
 * Agent `/trade` builds, signs, and sends with this key. Positions accrue here
 * (not on the discovering user's Privy wallet). Needs SOL + collateral —
 * `POST /api/agent/trader/fund`.
 */
export function agentTraderKeypair(): Keypair {
  return keypairFor("__agent_trader__", "GREEKBET_AGENT_TRADER_SECRET");
}
