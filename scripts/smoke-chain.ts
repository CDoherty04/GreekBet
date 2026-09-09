/**
 * End-to-end smoke test of the app's chain layer against devnet.
 *
 * Exercises the same modules the API routes use — no mocks, no fakes — so a
 * pass means the app can genuinely create a market, quote, trade and read a
 * position on chain.
 *
 *   npx tsx scripts/smoke-chain.ts
 *
 * Requires the funding wallet to hold devnet SOL and USDC. It creates a real
 * market with real collateral, so it costs the LMSR subsidy (`b·ln2`, ~6.93
 * USDC at the default liquidity) plus fees.
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";

import { buyShares, createMarket, sellShares } from "../src/lib/chain/actions";
import { quoteBuy } from "../src/lib/chain/quote";
import { COLLATERAL_MINT, formatUnits } from "../src/lib/chain/config";
import { derivePosition, deriveVault } from "../src/lib/chain/pdas";
import { connection } from "../src/lib/chain/program";
import { keypairFor, resolverKeypair } from "../src/lib/chain/wallet";

async function main() {
  const trader = keypairFor("smoke-trader");
  const resolver = resolverKeypair();
  const conn = connection();

  console.log("trader  ", trader.publicKey.toBase58());
  console.log("resolver", resolver.publicKey.toBase58());

  const sol = await conn.getBalance(trader.publicKey);
  console.log("SOL     ", sol / 1e9);

  const ata = await getAssociatedTokenAddress(COLLATERAL_MINT, trader.publicKey, true);
  let usdc = 0n;
  try {
    usdc = (await getAccount(conn, ata)).amount;
  } catch {
    /* no token account yet */
  }
  console.log("USDC    ", formatUnits(usdc.toString()));

  if (sol === 0) {
    console.error(
      `\nFUND REQUIRED: send devnet SOL to ${trader.publicKey.toBase58()}`,
    );
    process.exit(2);
  }
  if (usdc < 8_000_000n) {
    console.error(
      `\nFUND REQUIRED: send >= 8 devnet USDC to ${trader.publicKey.toBase58()}` +
        `\n(the market's LMSR subsidy alone is ~6.93 USDC)`,
    );
    process.exit(2);
  }

  const question = `Smoke test ${Date.now()}: will this settle?`;
  const closeTime = Math.floor(Date.now() / 1000) + 120;

  console.log("\n[1] create_market");
  const created = await createMarket({
    creator: trader,
    resolver: resolver.publicKey,
    question,
    closeTime,
  });
  console.log("    market  ", created.market);
  console.log("    seeded  ", formatUnits(created.seedAmount), "USDC");
  console.log("    sig     ", created.signature);

  const market = new PublicKey(created.market);
  const [vault] = deriveVault(market);
  const [position] = derivePosition(market, trader.publicKey);

  console.log("\n[2] quote 1.00 USDC of YES (simulated against the program)");
  const quoted = await quoteBuy({
    trader,
    market,
    outcome: "yes",
    collateral: 1_000_000n,
    traderAta: ata,
    vault,
    position,
  });
  console.log("    would receive", formatUnits(quoted.toString()), "YES shares");

  console.log("\n[3] buy_shares");
  const bought = await buyShares({
    trader,
    market,
    outcome: "yes",
    collateral: 1_000_000n,
  });
  console.log("    received", formatUnits(bought.received), "YES");
  console.log("    sig     ", bought.signature);

  if (bought.received !== quoted.toString()) {
    console.error(
      `\nMISMATCH: quote said ${quoted} but the trade gave ${bought.received}`,
    );
    process.exit(1);
  }
  console.log("    quote matched the executed trade exactly");

  console.log("\n[4] sell half back");
  const half = quoted / 2n;
  const sold = await sellShares({ trader, market, outcome: "yes", shares: half });
  console.log("    received", formatUnits(sold.received), "USDC");
  console.log("    sig     ", sold.signature);

  console.log("\n[5] vault");
  const vaultAccount = await getAccount(conn, vault);
  console.log("    holds   ", formatUnits(vaultAccount.amount.toString()), "USDC");

  console.log("\nOK — market", created.market);
}

main().catch((err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
