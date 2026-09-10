/**
 * Server-held Solana keypairs for **non-user** roles. **Server-only.**
 *
 * User wallets are Privy embedded Solana wallets — the app never holds those
 * secrets. This module only stores:
 *
 * * **resolver** — settles markets after AI / owner confirm
 * * **fee payer** — optional sponsor for resolver txs
 *
 * Keys live in `.data/keypairs.json`, gitignored, and are regenerated if the
 * file is lost — devnet only. Do not reuse this on mainnet.
 */

import "server-only";

import * as fs from "fs";
import * as path from "path";
import { Keypair } from "@solana/web3.js";

const KEY_FILE = path.join(process.cwd(), ".data", "keypairs.json");

type KeyStore = Record<string, number[]>;

function load(): KeyStore {
  try {
    return JSON.parse(fs.readFileSync(KEY_FILE, "utf8")) as KeyStore;
  } catch {
    return {};
  }
}

function persist(store: KeyStore): void {
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  const tmp = `${KEY_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, KEY_FILE);
}

function keypairFor(role: string): Keypair {
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
  return keypairFor(role);
}

/**
 * The resolver authority.
 *
 * One key for the whole deployment: markets are created with this as their
 * resolver, so the server can settle them once the AI reads the photo.
 */
export function resolverKeypair(): Keypair {
  const fromEnv = process.env.GREEKBET_RESOLVER_SECRET;
  if (fromEnv) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fromEnv) as number[]));
  }
  return keypairFor("__resolver__");
}

/**
 * The fee payer for server-submitted transactions (e.g. resolution).
 *
 * Needs devnet SOL; without it resolution fails deep in the runtime.
 */
export function feePayerKeypair(): Keypair {
  const fromEnv = process.env.GREEKBET_FEE_PAYER_SECRET;
  if (fromEnv) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fromEnv) as number[]));
  }
  return keypairFor("__fee_payer__");
}
