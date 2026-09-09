/**
 * Fund a devnet wallet so it can create markets and trade.
 *
 *   npm run fund -- <wallet-address>
 *
 * Sends SOL for fees and rent, and mints test collateral. Both are needed and
 * they fail differently: with no SOL every transaction dies inside the runtime
 * with an error that never mentions SOL, and with no collateral the trade
 * itself reverts.
 *
 * Collateral is the 6-decimal test mint whose authority the treasury holds.
 * Circle's devnet USDC cannot be minted by us — its faucet is reCAPTCHA-gated,
 * so an unattended top-up is impossible. The program only requires
 * `decimals == 6` and stores the mint per market, so the test mint behaves
 * identically; point `NEXT_PUBLIC_COLLATERAL_MINT` at Circle's if you have
 * some and want the real thing.
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
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";

const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";
const MINT = new PublicKey(
  process.env.NEXT_PUBLIC_COLLATERAL_MINT ??
    "5XWYAVBaM34pJx5LT9pNS8TdVJAb8ieHzqD9twZZ7zaG",
);

const SOL_TO_SEND = 0.5;
const COLLATERAL_TO_MINT = 100_000_000n; // 100 units, 6 decimals

function treasury(): Keypair {
  const file =
    process.env.SOLANA_KEYPAIR ??
    path.join(os.homedir(), ".config", "solana", "id.json");
  const secret = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: npm run fund -- <wallet-address>");
    process.exit(1);
  }

  const owner = new PublicKey(target);
  const payer = treasury();
  const conn = new Connection(RPC, "confirmed");

  console.log("treasury", payer.publicKey.toBase58());
  console.log("funding ", owner.toBase58());

  const treasurySol = await conn.getBalance(payer.publicKey);
  if (treasurySol < SOL_TO_SEND * LAMPORTS_PER_SOL) {
    console.error(
      `\nThe treasury only holds ${treasurySol / LAMPORTS_PER_SOL} SOL.` +
        `\nTop it up at https://faucet.solana.com — address above.`,
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
  const ata = await getAssociatedTokenAddress(MINT, owner, true);
  const ixs = [];

  let exists = true;
  try {
    await getAccount(conn, ata);
  } catch {
    exists = false;
  }
  if (!exists) {
    ixs.push(
      createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, MINT),
    );
  }
  ixs.push(
    createMintToInstruction(MINT, ata, payer.publicKey, COLLATERAL_TO_MINT),
  );

  try {
    const sig = await sendAndConfirmTransaction(
      conn,
      new Transaction().add(...ixs),
      [payer],
      { commitment: "confirmed" },
    );
    console.log(
      `  collateral minted ${Number(COLLATERAL_TO_MINT) / 1e6} — ${sig}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("owner does not match") || msg.includes("MintAuthority")) {
      console.error(
        `\nThe treasury does not hold the mint authority for ${MINT.toBase58()}.` +
          `\nThat is expected for Circle's USDC — it can only come from their faucet.`,
      );
      process.exit(2);
    }
    throw err;
  }

  const final = await getAccount(conn, ata);
  console.log(
    `\nready: ${(await conn.getBalance(owner)) / LAMPORTS_PER_SOL} SOL, ` +
      `${Number(final.amount) / 1e6} collateral`,
  );
}

main().catch((err) => {
  console.error("failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
