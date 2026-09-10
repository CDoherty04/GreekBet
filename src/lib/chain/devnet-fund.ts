/**
 * Devnet faucet from the project treasury. **Server-only.**
 *
 * Used by `npm run fund` and by signup so every new Privy wallet gets SOL +
 * test collateral without a manual step.
 */

import "server-only";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createMint,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getMint,
} from "@solana/spl-token";

import { COLLATERAL_MINT, RPC_URL } from "./config";

const PROJECT_TREASURY = path.join(process.cwd(), ".data", "treasury.json");
const PROJECT_MINT = path.join(process.cwd(), ".data", "collateral-mint.json");

const SOL_TO_SEND = 0.5;
const COLLATERAL_TO_MINT = 100_000_000n;
const SOL_SKIP_IF_ABOVE = 0.05 * LAMPORTS_PER_SOL;
const COLLATERAL_SKIP_IF_ABOVE = 10_000_000n; // 10 units

function loadTreasury(): Keypair | null {
  const candidates = [
    process.env.SOLANA_KEYPAIR,
    path.join(os.homedir(), ".config", "solana", "id.json"),
    PROJECT_TREASURY,
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    try {
      const secret = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(secret));
    } catch {
      /* try next */
    }
  }
  return null;
}

function readSavedMint(): PublicKey | null {
  try {
    const raw = JSON.parse(fs.readFileSync(PROJECT_MINT, "utf8")) as {
      mint: string;
    };
    return new PublicKey(raw.mint);
  } catch {
    return null;
  }
}

function saveMint(mint: PublicKey, authority: PublicKey): void {
  fs.mkdirSync(path.dirname(PROJECT_MINT), { recursive: true });
  fs.writeFileSync(
    PROJECT_MINT,
    JSON.stringify(
      {
        mint: mint.toBase58(),
        authority: authority.toBase58(),
        decimals: 6,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function resolveMint(
  conn: Connection,
  treasury: Keypair,
): Promise<PublicKey> {
  // Prefer env mint when the treasury can mint it.
  try {
    const info = await getMint(conn, COLLATERAL_MINT);
    if (info.mintAuthority?.equals(treasury.publicKey)) {
      return COLLATERAL_MINT;
    }
  } catch {
    /* fall through */
  }

  const saved = readSavedMint();
  if (saved) {
    try {
      const info = await getMint(conn, saved);
      if (info.mintAuthority?.equals(treasury.publicKey)) return saved;
    } catch {
      /* recreate */
    }
  }

  const mint = await createMint(
    conn,
    treasury,
    treasury.publicKey,
    null,
    6,
  );
  saveMint(mint, treasury.publicKey);
  return mint;
}

export interface FundResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  sol?: number;
  collateral?: number;
  mint?: string;
  address: string;
}

/**
 * Top up `address` with SOL + test collateral if balances are low.
 * Idempotent: skips when already funded.
 */
export async function fundDevnetWallet(address: string): Promise<FundResult> {
  const owner = new PublicKey(address);
  const treasury = loadTreasury();
  if (!treasury) {
    return {
      ok: false,
      address,
      reason:
        "No treasury keypair (.data/treasury.json). Run: npm run fund -- <address> once to create it, faucet that treasury, then retry.",
    };
  }

  const conn = new Connection(RPC_URL, "confirmed");
  const treasurySol = await conn.getBalance(treasury.publicKey);
  if (treasurySol < SOL_TO_SEND * LAMPORTS_PER_SOL) {
    return {
      ok: false,
      address,
      reason: `Treasury ${treasury.publicKey.toBase58()} needs SOL from https://faucet.solana.com`,
    };
  }

  const mint = await resolveMint(conn, treasury);
  let sol = await conn.getBalance(owner);

  if (sol < SOL_SKIP_IF_ABOVE) {
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: treasury.publicKey,
          toPubkey: owner,
          lamports: SOL_TO_SEND * LAMPORTS_PER_SOL,
        }),
      ),
      [treasury],
      { commitment: "confirmed" },
    );
    sol = await conn.getBalance(owner);
  }

  const ata = await getAssociatedTokenAddress(mint, owner, true);
  let amount = 0n;
  let exists = true;
  try {
    amount = (await getAccount(conn, ata)).amount;
  } catch {
    exists = false;
  }

  if (!exists || amount < COLLATERAL_SKIP_IF_ABOVE) {
    const ixs = [];
    if (!exists) {
      ixs.push(
        createAssociatedTokenAccountInstruction(
          treasury.publicKey,
          ata,
          owner,
          mint,
        ),
      );
    }
    ixs.push(
      createMintToInstruction(
        mint,
        ata,
        treasury.publicKey,
        COLLATERAL_TO_MINT,
      ),
    );
    await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [
      treasury,
    ], { commitment: "confirmed" });
    amount = (await getAccount(conn, ata)).amount;
  }

  return {
    ok: true,
    skipped: sol >= SOL_SKIP_IF_ABOVE && amount >= COLLATERAL_SKIP_IF_ABOVE,
    address,
    sol: sol / LAMPORTS_PER_SOL,
    collateral: Number(amount) / 1e6,
    mint: mint.toBase58(),
  };
}
