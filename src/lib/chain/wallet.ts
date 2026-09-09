/**
 * Custodial Solana keypairs, one per user. **Server-only.**
 *
 * ## Why custodial, and why this is a seam not a decision
 *
 * The app's pitch is "selfie + phone, no seed phrase", with wallets
 * auto-provisioned by Privy. `integrations/privy.ts` is still a stub that
 * returns a fake **EVM** address (`0x…`), which cannot sign a Solana
 * transaction at all — so there is no browser-side signer to build on today.
 *
 * Trading therefore signs on the server with a keypair the server holds. That
 * is consistent with what the app already did (it managed an internal token
 * balance on the user's behalf) and it keeps the onboarding promise intact.
 *
 * **It is not non-custodial and should not be described as such.** The program
 * itself is non-custodial — collateral sits in a program-owned vault, and only
 * the position owner can sell or redeem. What is custodial is the *key*, which
 * is a property of this app, not of the market.
 *
 * Swapping in real Privy (or a browser wallet) means replacing `signerFor` with
 * something that returns a signer instead of a `Keypair`; nothing above this
 * module inspects the secret key.
 *
 * Keys live in `.data/keypairs.json`, gitignored, and are regenerated if the
 * file is lost — devnet only, no real funds. Do not reuse this on mainnet.
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
  // Temp-then-rename: a crash mid-write would otherwise strand every user's key.
  const tmp = `${KEY_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, KEY_FILE);
}

/** The keypair for a user, created on first use. */
export function keypairFor(userId: string): Keypair {
  const store = load();
  const existing = store[userId];
  if (existing) return Keypair.fromSecretKey(Uint8Array.from(existing));

  const kp = Keypair.generate();
  store[userId] = Array.from(kp.secretKey);
  persist(store);
  return kp;
}

/**
 * The resolver authority.
 *
 * One key for the whole deployment: markets are created with this as their
 * resolver, so the server can settle them once the AI reads the photo. The
 * program treats the resolver as a bare pubkey with no logic attached — a
 * deliberate seam — so replacing this with a multisig or an oracle later
 * changes nothing on chain beyond which key is stored.
 */
export function resolverKeypair(): Keypair {
  const fromEnv = process.env.GREEKBET_RESOLVER_SECRET;
  if (fromEnv) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fromEnv) as number[]));
  }
  return keypairFor("__resolver__");
}

/**
 * The fee payer for server-submitted transactions.
 *
 * Separate from the resolver so the two roles can diverge later. Needs devnet
 * SOL; without it every transaction fails with an unhelpful "insufficient
 * funds for rent" from deep inside the runtime.
 */
export function feePayerKeypair(): Keypair {
  const fromEnv = process.env.GREEKBET_FEE_PAYER_SECRET;
  if (fromEnv) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fromEnv) as number[]));
  }
  return keypairFor("__fee_payer__");
}
