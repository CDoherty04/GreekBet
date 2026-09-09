/**
 * Capture real devnet transaction logs as decoder test fixtures.
 *
 * The plan (§6) asks for decoder tests fed "captured raw log samples (from
 * devnet test transactions)" rather than hand-written strings. Synthetic logs
 * only prove the decoder agrees with whoever wrote the fixture; these come from
 * the T10 lifecycle run against the deployed program, so they exercise the real
 * borsh layouts, the real discriminators, and the real surrounding noise from
 * the SPL Token and System programs in the same transactions.
 *
 *   npx ts-node scripts/capture-fixtures.ts [--endpoint <url>]
 *
 * Re-run only when the program's events change; the committed fixtures are
 * otherwise stable and the tests must not need the network.
 */

import * as fs from "fs";
import * as path from "path";

import { Connection } from "@solana/web3.js";

/** The T10 devnet lifecycle, in chain order. Covers all six event types. */
const LIFECYCLE: Array<{ label: string; signature: string }> = [
  { label: "create_market", signature: "2JebBUAZZgXWMcKGtihgCoTVCDW4zckQaweqEVmhZsDfznUDdhkZk1EeGWGL222hT2tmUdHMQT2TsxM9HegwGXeM" },
  { label: "buy_yes_a", signature: "3XLcFrfbCoQPasUJR8QQYvrrJJTbHA4PVBarAoMPbiHWmrVRR2Npf26aBwVsjABtTASWPZXcsVC4XCjECdu4kHq3" },
  { label: "buy_no_b", signature: "cVhQh4WxnVrM5J9fKeYg8TYTPzrNKK8nEwqCq5BdjWVrqG6RiaQWs1bZ5jiHgUTEBB6YiJt8jqFsn1D1W3YnQQS" },
  { label: "buy_yes_c", signature: "3kwRGUwidj95j77Vv3nWkdt6TfNAeZDUVUALvpttbUfs6kmTCwtPendLNhifmeYVDAURqLU3Hc6CUpryPLdQ73Pd" },
  { label: "sell_a", signature: "5GMkarkhAossJbz1dtGDEtECu8VcN6Ch5JUciRhFJM51jcGrXYKsyotS58eANe4GNQWnsJU1H4vDaVPRA9qNheMu" },
  { label: "close_market", signature: "3KoEbzQtFWMwoSe92wXGZR6GyB9j8fNgbpUyf4PD6y8nZM7M6yp85E3XEEbSUh3HkzJCYf4EotrYBLu1N2hJs2dR" },
  { label: "resolve_market", signature: "4ZFsTUMn7ShVeZ5MWnPMTzECB5v8AGf5YxQY9WuKDXMbXShWDARzu1ydznx8Rrwpr8QeD6Qgh6CxATNmMEFJA2eC" },
  { label: "redeem_winner_a", signature: "2DMvUCK7hfRQj5ks9nKT756UweXqDJErPdDFUfuFqiCrHYwpnMQ3hEy2iunmWNLiYy5Sss3jh3npdeXq4UBcRT52" },
  { label: "redeem_winner_c", signature: "2ud5JrRcFg5ZAAkuBBupuANRierzPhE3ZLH8AUz7YGRrqVhYEFoSMoFmELgFAz6njwto5Esz3CgMaAE9ryqp1Xs7" },
  { label: "redeem_loser_b", signature: "5t48nfRVdHLsSxJxvnrs8qda55gmCB18Fj1forUf5JHf5qs7Vs2Vbe4oTu7ZHmdTg6ZoqRmYYi6k6pizLAAAfa3L" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--endpoint");
  const endpoint =
    i !== -1 && argv[i + 1] ? (argv[i + 1] as string) : "https://api.devnet.solana.com";

  const connection = new Connection(endpoint, "confirmed");
  const outDir = path.join(__dirname, "..", "test", "fixtures");
  fs.mkdirSync(outDir, { recursive: true });

  const captured: unknown[] = [];

  for (const { label, signature } of LIFECYCLE) {
    process.stdout.write(`${label} … `);
    let tx = null;
    // Devnet 429s in bursts; a confirmed signature can also 404 briefly.
    for (let attempt = 0; attempt < 5 && !tx; attempt++) {
      try {
        tx = await connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
      } catch (err) {
        process.stdout.write(`retry(${(err as Error).message.slice(0, 40)}) `);
      }
      if (!tx) await sleep(1000 * 2 ** attempt);
    }
    if (!tx || !tx.meta) {
      console.log("MISSING");
      continue;
    }

    captured.push({
      label,
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime ?? null,
      failed: tx.meta.err !== null,
      logs: tx.meta.logMessages ?? [],
    });
    console.log(`ok (slot ${tx.slot}, ${tx.meta.logMessages?.length ?? 0} logs)`);
    await sleep(400); // stay under the rate limit
  }

  const outFile = path.join(outDir, "devnet-lifecycle.json");
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        source: "devnet T10 lifecycle run, real Circle USDC",
        program: "GRUTmtYopUczvS5m62YAvctbS9TTrbznnnj5GmFHumSZ",
        captured: new Date().toISOString(),
        transactions: captured,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  console.log(`\nwrote ${captured.length} transactions to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
