/**
 * Fund a Privy (or any) Solana wallet on **devnet**.
 *
 *   npm run fund -- <wallet-address>
 *
 * Two wallets are involved:
 *
 * 1. **Target** — the address you pass (your Privy embedded wallet from Profile).
 * 2. **Treasury** — local keypair at `.data/treasury.json` that pays SOL and
 *    (usually) mints test collateral.
 *
 * If the configured mint's authority is not the treasury, this script creates
 * a fresh 6-decimal mint under `.data/collateral-mint.json` and prints the
 * `NEXT_PUBLIC_COLLATERAL_MINT=` line to put in `.env.local`.
 */

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

const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";
const PROJECT_TREASURY = path.join(process.cwd(), ".data", "treasury.json");
const PROJECT_MINT = path.join(process.cwd(), ".data", "collateral-mint.json");
const SOL_TO_SEND = 0.5;
const COLLATERAL_TO_MINT = 100_000_000n; // 100 units, 6 decimals

function loadOrCreateTreasury(): { keypair: Keypair; path: string; created: boolean } {
  const candidates = [
    process.env.SOLANA_KEYPAIR,
    path.join(os.homedir(), ".config", "solana", "id.json"),
    PROJECT_TREASURY,
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    try {
      const secret = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
      return {
        keypair: Keypair.fromSecretKey(Uint8Array.from(secret)),
        path: file,
        created: false,
      };
    } catch {
      /* try next */
    }
  }

  fs.mkdirSync(path.dirname(PROJECT_TREASURY), { recursive: true });
  const kp = Keypair.generate();
  fs.writeFileSync(
    PROJECT_TREASURY,
    JSON.stringify(Array.from(kp.secretKey)),
    "utf8",
  );
  return { keypair: kp, path: PROJECT_TREASURY, created: true };
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

async function ensureMint(
  conn: Connection,
  treasury: Keypair,
): Promise<{ mint: PublicKey; created: boolean }> {
  const envMint = process.env.NEXT_PUBLIC_COLLATERAL_MINT;
  if (envMint) {
    const mint = new PublicKey(envMint);
    try {
      const info = await getMint(conn, mint);
      if (info.mintAuthority?.equals(treasury.publicKey)) {
        return { mint, created: false };
      }
      console.warn(
        `NEXT_PUBLIC_COLLATERAL_MINT=${envMint} is not mintable by this treasury.` +
          `\nCreating a project mint instead (or use Circle faucet for that mint).`,
      );
    } catch {
      console.warn(`Could not read mint ${envMint}; creating a project mint.`);
    }
  }

  const saved = readSavedMint();
  if (saved) {
    try {
      const info = await getMint(conn, saved);
      if (info.mintAuthority?.equals(treasury.publicKey)) {
        return { mint: saved, created: false };
      }
    } catch {
      /* recreate below */
    }
  }

  console.log("Creating 6-decimal test collateral mint (treasury = mint authority)…");
  const mint = await createMint(
    conn,
    treasury,
    treasury.publicKey,
    null,
    6,
  );
  saveMint(mint, treasury.publicKey);
  return { mint, created: true };
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: npm run fund -- <wallet-address>");
    console.error(
      "\nPass the Solana address from Profile (your Privy embedded wallet).",
    );
    process.exit(1);
  }

  const owner = new PublicKey(target);
  const { keypair: payer, path: treasuryPath, created } =
    loadOrCreateTreasury();
  const conn = new Connection(RPC, "confirmed");

  console.log("treasury file", treasuryPath);
  console.log("treasury     ", payer.publicKey.toBase58());
  console.log("funding      ", owner.toBase58());

  if (created) {
    console.error(
      `\nCreated a new treasury at ${treasuryPath}.` +
        `\nIt has 0 SOL. Get free SOL once, then re-run this command:` +
        `\n  https://faucet.solana.com` +
        `\n  address: ${payer.publicKey.toBase58()}`,
    );
    process.exit(2);
  }

  const treasurySol = await conn.getBalance(payer.publicKey);
  if (treasurySol < SOL_TO_SEND * LAMPORTS_PER_SOL) {
    console.error(
      `\nThe treasury only holds ${treasurySol / LAMPORTS_PER_SOL} SOL.` +
        `\nTop it up at https://faucet.solana.com` +
        `\n  address: ${payer.publicKey.toBase58()}`,
    );
    process.exit(2);
  }

  // --- SOL -------------------------------------------------------------
  const already = await conn.getBalance(owner);
  if (already >= 0.05 * LAMPORTS_PER_SOL) {
    console.log(`  SOL       already has ${already / LAMPORTS_PER_SOL}, skipping`);
  } else {
    const sig = await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: owner,
          lamports: SOL_TO_SEND * LAMPORTS_PER_SOL,
        }),
      ),
      [payer],
      { commitment: "confirmed" },
    );
    console.log(`  SOL       sent ${SOL_TO_SEND} — ${sig}`);
  }

  // --- collateral ------------------------------------------------------
  const { mint, created: mintCreated } = await ensureMint(conn, payer);
  console.log("collateral   ", mint.toBase58());

  const ata = await getAssociatedTokenAddress(mint, owner, true);
  const ixs = [];

  let exists = true;
  try {
    await getAccount(conn, ata);
  } catch {
    exists = false;
  }
  if (!exists) {
    ixs.push(
      createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint),
    );
  }
  ixs.push(
    createMintToInstruction(mint, ata, payer.publicKey, COLLATERAL_TO_MINT),
  );

  const sig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(...ixs),
    [payer],
    { commitment: "confirmed" },
  );
  console.log(
    `  collateral minted ${Number(COLLATERAL_TO_MINT) / 1e6} — ${sig}`,
  );

  const final = await getAccount(conn, ata);
  console.log(
    `\nready: ${(await conn.getBalance(owner)) / LAMPORTS_PER_SOL} SOL, ` +
      `${Number(final.amount) / 1e6} collateral`,
  );

  if (mintCreated || process.env.NEXT_PUBLIC_COLLATERAL_MINT !== mint.toBase58()) {
    console.log(
      `\nAdd this to .env.local and restart npm run dev:\n` +
        `  NEXT_PUBLIC_COLLATERAL_MINT=${mint.toBase58()}`,
    );
  }
}

main().catch((err) => {
  console.error("failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
