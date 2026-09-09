/**
 * tests/devnet/lifecycle.ts — T10 step 4: the T09 lifecycle, against devnet.
 *
 *   bash scripts/devnet/run-lifecycle.sh
 *
 * create -> buy (three users) -> sell -> close -> resolve -> redeem, plus the
 * resolver access-control check that plan §4.3 names as its own exit criterion.
 *
 * =========================================================================
 * WHY THIS IS A SEPARATE FILE INSTEAD OF A FLAG ON tests/lifecycle.ts
 * =========================================================================
 *
 * `tests/lifecycle.ts` is hermetic by construction: it airdrops SOL, creates a
 * throwaway mint and mints freely. None of that is available on devnet — the
 * faucet is rate-limited to nothing and Circle owns the USDC mint authority —
 * so the setup half has to come from `scripts/devnet/fund.ts` (persisted
 * wallets, funded once, reused) rather than from the test.
 *
 * What is genuinely shared is imported from `../utils`: the PDA derivations,
 * the error-code table, `bLn2Floor`, `VaultLedger`, `outcomeArg`. Those are
 * pure functions with no network in them, and duplicating the market-PDA
 * derivation in particular would be the single most likely way to make this
 * file wrong.
 *
 * =========================================================================
 * SELF-SKIP
 * =========================================================================
 *
 * Anchor.toml's test glob is `tests/**\/*.ts`, so a plain
 * `anchor test --validator legacy` picks this file up too. It must not then try
 * to talk to devnet, and it must not fail the local suite. `before()` therefore
 * skips the whole suite unless the provider URL is a devnet one *and* a funding
 * manifest exists. Running it deliberately is `scripts/devnet/run-lifecycle.sh`.
 *
 * =========================================================================
 * WHAT IS DIFFERENT FROM THE LOCAL SUITE (all of it forced by devnet)
 * =========================================================================
 *
 * 1. **Send-and-confirm is hand-rolled, not `.rpc()`.** A blockhash expires
 *    after ~60-90 s of real time and the public RPC returns 429 under any
 *    sustained load. Both are retryable; a program error is not. `send()` below
 *    signs, sends raw, and on a failure **checks whether the transaction landed
 *    anyway** (`getSignatureStatus`) before rebuilding with a fresh blockhash —
 *    a naive retry loop would double-spend a `buy_shares`.
 *
 * 2. **Commitment is pinned to `confirmed` everywhere.** `AnchorProvider.env()`
 *    defaults to `processed`, where a read straight after a send can legally
 *    return the pre-transaction state. Locally that is a rare flake; on devnet,
 *    with real propagation delay, it is the common case.
 *
 * 3. **`close_time` is a real wall-clock wait.** There is no clock warp here
 *    any more than there is on solana-test-validator, and devnet slots are
 *    ~400-600 ms rather than the local validator's much faster ones, so the
 *    Clock sysvar is polled instead of the host clock (the program compares
 *    against exactly that value).
 *
 * 4. **Every assertion is on the same numbers as the local suite.** The point
 *    of the pass is to find behaviour that differs; the way to find it is not
 *    to loosen the assertions.
 */

import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { EventParser, Program } from "@anchor-lang/core";
import { expect } from "chai";
import * as bs58 from "bs58";
import * as fs from "fs";
import * as path from "path";

import {
  bLn2Floor,
  big,
  bn,
  COMMITMENT,
  deriveMarket,
  derivePosition,
  deriveVault,
  ERR,
  getConnection,
  getProgram,
  getProvider,
  LANG_ERR,
  maxBig,
  outcomeArg,
  sha256,
  UNIT,
  VaultLedger,
} from "../utils";
import {
  FUNDING_FILE,
  readFundingManifest,
  readKeypair,
  sleep,
  STATE_DIR,
  withRetry,
  type FundingManifest,
} from "../../scripts/devnet/fund";

import type { Greekbet } from "../../target/types/greekbet";

// ---------------------------------------------------------------------------
// Run configuration
// ---------------------------------------------------------------------------

/**
 * `b` and the three trade sizes come from the funding manifest, not from a
 * constant here, because they depend on which collateral path ran.
 *
 * On the custom mint they are byte-for-byte the values `tests/lifecycle.ts`
 * uses locally (b = 100, spends of 10 / 4 / 20), which is what makes the local
 * and devnet accounting numbers directly comparable. On Circle's mint they are
 * scaled to `b = B_MIN` so the whole fixture fits inside two 10-USDC drips.
 * See `SCALES` in scripts/devnet/fund.ts.
 */
let B: bigint;
let SPEND_A: bigint;
let SPEND_B: bigint;
let SPEND_C: bigint;

/**
 * Real seconds between `create_market` and `close_time`.
 *
 * Six transactions have to land inside this window. Measured on devnet they
 * take ~1-3 s each at `confirmed`, so 120 s is roughly 6x the observed need
 * while still keeping the suite under five minutes. Widen it with
 * `GB_CLOSE_WINDOW` if the RPC is having a bad day.
 */
const CLOSE_WINDOW_S = Number(process.env.GB_CLOSE_WINDOW ?? 120);

const RUN_LOG = path.join(STATE_DIR, "lifecycle-run.json");

interface StepRecord {
  step: string;
  signature: string;
  computeUnits: number | null;
  slot: number | null;
  note?: string;
}

const steps: StepRecord[] = [];

function explorer(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

// ---------------------------------------------------------------------------
// Devnet send/confirm
// ---------------------------------------------------------------------------

interface SentTx {
  signature: string;
  slot: number | null;
  logs: string[];
  events: Record<string, any>;
  computeUnits: number | null;
}

/**
 * Read a transaction back once it is queryable at `confirmed`.
 *
 * On the local validator this is instant. On devnet the RPC node that answers
 * `getTransaction` is not necessarily the one that confirmed the send, so a
 * freshly confirmed signature can 404 for a second or two — and under 429
 * pressure for considerably longer. 60 s of polling, not the local suite's 5 s.
 */
async function getTransactionWithRetry(signature: string, budgetMs = 60_000): Promise<any> {
  const connection = getConnection();
  const deadline = Date.now() + budgetMs;
  let delay = 400;
  for (;;) {
    try {
      const tx = await connection.getTransaction(signature, {
        commitment: COMMITMENT,
        maxSupportedTransactionVersion: 0,
      });
      if (tx?.meta?.logMessages) return tx;
    } catch {
      /* 429 or a node that has not caught up; fall through to the sleep */
    }
    if (Date.now() > deadline) {
      throw new Error(`transaction ${signature} never became readable at ${COMMITMENT}`);
    }
    await sleep(delay);
    delay = Math.min(3000, Math.round(delay * 1.5));
  }
}

function decode(program: Program<Greekbet>, logs: string[]): Record<string, any> {
  const parser = new EventParser(program.programId, program.coder);
  const events: Record<string, any> = {};
  for (const ev of parser.parseLogs(logs)) {
    events[ev.name] = ev.data;
    events[ev.name[0].toLowerCase() + ev.name.slice(1)] = ev.data;
    events[ev.name[0].toUpperCase() + ev.name.slice(1)] = ev.data;
  }
  return events;
}

function scrapeComputeUnits(programId: string, logs: string[]): number | null {
  for (const line of logs) {
    const m = /consumed (\d+) of \d+ compute units/.exec(line);
    if (m && line.includes(programId)) return Number(m[1]);
  }
  return null;
}

/**
 * Send an Anchor `methods` builder and wait for it, devnet-style.
 *
 * The important part is the recovery path. `confirmTransaction` throws
 * `TransactionExpiredBlockheightExceededError` when the blockhash's window
 * closes, but that says nothing about whether the transaction landed — it
 * routinely has. So before rebuilding, ask the cluster: if the signature
 * already has a confirmation status, the send succeeded and retrying would
 * apply the instruction twice. Only a signature the cluster has never seen is
 * safe to re-sign against a new blockhash.
 */
async function send(
  program: Program<Greekbet>,
  builder: any,
  extraSigners: Keypair[],
  label: string,
  attempts = 5
): Promise<SentTx> {
  const provider = getProvider();
  const connection = getConnection();
  const payer = feePayer();
  let lastErr: any;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const tx: Transaction = await builder.transaction();
    const { blockhash, lastValidBlockHeight } = await withRetry(`${label}: blockhash`, () =>
      connection.getLatestBlockhash(COMMITMENT)
    );
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(payer, ...extraSigners);
    const signature = bs58.encode(tx.signature as Buffer);

    try {
      await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: COMMITMENT,
        maxRetries: 5,
      });
      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        COMMITMENT
      );
    } catch (err: any) {
      lastErr = err;
      // Did it land regardless? Never re-send a transaction that may have
      // executed: `buy_shares` is not idempotent.
      let landed = false;
      try {
        const st = await connection.getSignatureStatus(signature, {
          searchTransactionHistory: true,
        });
        landed = !!st?.value && st.value.err === null;
        if (st?.value?.err) throw err;
      } catch {
        landed = false;
      }
      if (!landed) {
        if (await isProgramError(err)) throw err;
        if (attempt === attempts) throw err;
        // eslint-disable-next-line no-console
        console.warn(
          `    [retry ${attempt}/${attempts}] ${label}: ${String(err?.message).split("\n")[0]}`
        );
        await sleep(1500 * attempt);
        continue;
      }
    }

    const confirmed = await getTransactionWithRetry(signature);
    const logs: string[] = confirmed.meta.logMessages;
    return {
      signature,
      slot: confirmed.slot ?? null,
      logs,
      events: decode(program, logs),
      computeUnits: scrapeComputeUnits(program.programId.toBase58(), logs),
    };
  }
  throw lastErr;
}

async function record(
  program: Program<Greekbet>,
  builder: any,
  signers: Keypair[],
  step: string
): Promise<SentTx> {
  const t0 = Date.now();
  const tx = await send(program, builder, signers, step);
  const ms = Date.now() - t0;
  steps.push({ step, signature: tx.signature, computeUnits: tx.computeUnits, slot: tx.slot });
  // eslint-disable-next-line no-console
  console.log(
    `    ${step.padEnd(34)} ${tx.signature}  (${ms} ms, ${
      tx.computeUnits === null ? "?" : tx.computeUnits
    } CU)`
  );
  return tx;
}

function requireEvent(tx: SentTx, name: string): any {
  const ev = tx.events[name];
  if (!ev) {
    throw new Error(
      `expected a "${name}" event; saw [${Object.keys(tx.events).join(", ")}] in ${tx.signature}`
    );
  }
  return ev;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * web3.js 1.98's `SendTransactionError` no longer populates `.logs` eagerly —
 * the simulation logs are behind `getLogs(connection)`. Without this, an
 * error-code assertion on devnet sees only "Transaction simulation failed" and
 * every negative test fails for the wrong reason.
 */
async function logsOf(err: any): Promise<string[]> {
  if (Array.isArray(err?.logs) && err.logs.length) return err.logs;
  if (typeof err?.getLogs === "function") {
    try {
      const l = await err.getLogs(getConnection());
      if (Array.isArray(l)) return l;
    } catch {
      /* ignore */
    }
  }
  return [];
}

async function errorCodeOf(err: any): Promise<number | null> {
  const direct = err?.error?.errorCode?.number;
  if (typeof direct === "number") return direct;
  if (typeof err?.code === "number" && err.code >= 100) return err.code;

  const logs = await logsOf(err);
  const text = [String(err?.message ?? ""), ...logs].join("\n");

  const named = /Error Number: (\d+)/.exec(text);
  if (named) return Number(named[1]);
  const custom = /custom program error: (0x[0-9a-fA-F]+|\d+)/.exec(text);
  if (custom) {
    return custom[1].startsWith("0x") ? parseInt(custom[1], 16) : parseInt(custom[1], 10);
  }
  return null;
}

async function isProgramError(err: any): Promise<boolean> {
  return (await errorCodeOf(err)) !== null;
}

async function expectError(
  promise: Promise<any>,
  expectedCode: number,
  what: string
): Promise<void> {
  let threw = false;
  let caught: any;
  try {
    await promise;
  } catch (err) {
    threw = true;
    caught = err;
  }
  expect(threw, `${what}: expected error ${expectedCode} but the call succeeded`).to.equal(true);
  const code = await errorCodeOf(caught);
  if (code !== expectedCode) {
    const logs = await logsOf(caught);
    throw new Error(
      `${what}: expected error code ${expectedCode}, got ${code}\n` +
        `message: ${caught?.message}\n` +
        (logs.length ? `logs:\n  ${logs.join("\n  ")}` : "")
    );
  }
}

/** Build + sign + send, expecting a failure — no retry, a revert is final. */
async function sendExpectingFailure(builder: any, extraSigners: Keypair[]): Promise<void> {
  const connection = getConnection();
  const payer = feePayer();
  const tx: Transaction = await builder.transaction();
  const { blockhash } = await connection.getLatestBlockhash(COMMITMENT);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(payer, ...extraSigners);
  await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: COMMITMENT,
  });
}

// ---------------------------------------------------------------------------
// Readers (retry-wrapped)
// ---------------------------------------------------------------------------

let _payer: Keypair | undefined;
function feePayer(): Keypair {
  if (!_payer) throw new Error("fee payer not initialised");
  return _payer;
}

async function readMarket(program: Program<Greekbet>, market: PublicKey): Promise<any> {
  const raw: any = await withRetry("readMarket", () =>
    (program.account as any).market.fetch(market, COMMITMENT)
  );
  return {
    ...raw,
    createdAt: big(raw.createdAt),
    closeTime: big(raw.closeTime),
    b: big(raw.b),
    qYes: big(raw.qYes),
    qNo: big(raw.qNo),
    statusKey: Object.keys(raw.status)[0],
    winner: raw.winningOutcome === null ? null : Object.keys(raw.winningOutcome)[0],
  };
}

async function readPosition(program: Program<Greekbet>, position: PublicKey): Promise<any> {
  const raw: any = await withRetry("readPosition", () =>
    (program.account as any).userPosition.fetch(position, COMMITMENT)
  );
  return { ...raw, yesShares: big(raw.yesShares), noShares: big(raw.noShares) };
}

async function positionExists(position: PublicKey): Promise<boolean> {
  const info = await withRetry("getAccountInfo(position)", () =>
    getConnection().getAccountInfo(position, COMMITMENT)
  );
  return info !== null && info.data.length > 0;
}

async function tokenBalance(account: PublicKey): Promise<bigint> {
  const acc = await withRetry("getAccount", () =>
    getAccount(getConnection(), account, COMMITMENT, TOKEN_PROGRAM_ID)
  );
  return acc.amount;
}

/**
 * `Clock::unix_timestamp` as the program sees it.
 *
 * Read from the sysvar, not from `Date.now()`: devnet's clock is a cluster
 * consensus value and has drifted by whole seconds from the host clock during
 * this ticket. The program compares `close_time` against exactly this number.
 */
async function onChainUnixTime(): Promise<number> {
  const info = await withRetry("clock sysvar", () =>
    getConnection().getAccountInfo(
      new PublicKey("SysvarC1ock11111111111111111111111111111111"),
      COMMITMENT
    )
  );
  if (!info) throw new Error("could not read the Clock sysvar");
  return Number(info.data.readBigInt64LE(32));
}

async function waitForOnChainTime(ts: number, budgetMs = 420_000): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let announced = false;
  for (;;) {
    const now = await onChainUnixTime();
    if (now >= ts) return now;
    if (!announced) {
      // eslint-disable-next-line no-console
      console.log(`    waiting ${ts - now}s of real time for the on-chain clock to reach ${ts}`);
      announced = true;
    }
    if (Date.now() > deadline) {
      throw new Error(`on-chain clock never reached ${ts} (still ${now}) within ${budgetMs}ms`);
    }
    // 2 s, not the local suite's 500 ms: the public devnet RPC 429s under a
    // tight poll and the extra precision buys nothing against a 400-600 ms slot.
    await sleep(2000);
  }
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe("devnet lifecycle: create -> buy -> sell -> close -> resolve -> redeem", () => {
  let program: Program<Greekbet>;
  let manifest: FundingManifest;
  let mint: PublicKey;

  let creator: Keypair;
  let resolver: Keypair;
  let a: Keypair;
  let b: Keypair;
  let c: Keypair;
  let creatorAta: PublicKey;
  let ataA: PublicKey;
  let ataB: PublicKey;
  let ataC: PublicKey;

  let question: string;
  let market: PublicKey;
  let vault: PublicKey;
  let posA: PublicKey;
  let posB: PublicKey;
  let posC: PublicKey;
  let closeTime: number;
  let seed: bigint;
  let ledger: VaultLedger;

  let sharesA = 0n;
  let sharesB = 0n;
  let sharesC = 0n;
  let payouts = 0n;
  const priceAfter: bigint[] = [];
  const cu: Record<string, number | null> = {};

  before(async function () {
    this.timeout(120_000);

    const url = process.env.ANCHOR_PROVIDER_URL ?? "";
    if (!/devnet/i.test(url)) {
      // eslint-disable-next-line no-console
      console.log(
        `  [skip] ANCHOR_PROVIDER_URL is "${url || "<unset>"}", not devnet. ` +
          `Run scripts/devnet/run-lifecycle.sh to execute this suite.`
      );
      this.skip();
      return;
    }
    if (!fs.existsSync(FUNDING_FILE)) {
      // eslint-disable-next-line no-console
      console.log(`  [skip] no funding manifest at ${FUNDING_FILE}; run scripts/devnet/fund.ts`);
      this.skip();
      return;
    }

    manifest = readFundingManifest();
    B = BigInt(manifest.scale.b);
    SPEND_A = BigInt(manifest.scale.spendA);
    SPEND_B = BigInt(manifest.scale.spendB);
    SPEND_C = BigInt(manifest.scale.spendC);
    _payer = readKeypair(
      process.env.ANCHOR_WALLET ?? path.join(process.env.HOME ?? "", ".config/solana/id.json")
    );
    program = getProgram();
    mint = new PublicKey(manifest.mint);

    creator = readKeypair(manifest.wallets.creator.keypairFile);
    a = readKeypair(manifest.wallets.traderA.keypairFile);
    b = readKeypair(manifest.wallets.traderB.keypairFile);
    c = readKeypair(manifest.wallets.traderC.keypairFile);
    creatorAta = new PublicKey(manifest.wallets.creator.tokenAccount);
    ataA = new PublicKey(manifest.wallets.traderA.tokenAccount);
    ataB = new PublicKey(manifest.wallets.traderB.tokenAccount);
    ataC = new PublicKey(manifest.wallets.traderC.tokenAccount);
    // The resolver never pays for anything and never signs anything except
    // `resolve_market`, so it needs no SOL and can be ephemeral.
    resolver = Keypair.generate();

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        `  cluster        : devnet (${url})`,
        `  program        : ${program.programId.toBase58()}`,
        `  collateral path: ${manifest.collateralPath}`,
        `  real USDC?     : ${manifest.isRealCircleUsdc ? "YES" : "NO — custom mint"}`,
        `  mint           : ${manifest.mint}`,
        `  b              : ${B} (spends ${SPEND_A} / ${SPEND_B} / ${SPEND_C})`,
        `  fee payer      : ${feePayer().publicKey.toBase58()}`,
        "",
      ].join("\n")
    );
  });

  it("creates a market and seeds the vault with exactly b*ln2", async function () {
    this.timeout(300_000);

    question = `T10 devnet lifecycle [${Date.now().toString(36)}]`;
    [market] = deriveMarket(program.programId, creator.publicKey, question);
    [vault] = deriveVault(program.programId, market);
    posA = derivePosition(program.programId, market, a.publicKey)[0];
    posB = derivePosition(program.programId, market, b.publicKey)[0];
    posC = derivePosition(program.programId, market, c.publicKey)[0];

    seed = bLn2Floor(B);
    ledger = new VaultLedger(seed);
    closeTime = (await onChainUnixTime()) + CLOSE_WINDOW_S;

    const tx = await record(
      program,
      program.methods
        .createMarket(question, bn(closeTime), bn(B), resolver.publicKey)
        .accountsPartial({
          creator: creator.publicKey,
          market,
          collateralMint: mint,
          vault,
          creatorTokenAccount: creatorAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }),
      [creator],
      "create_market"
    );
    cu["create_market"] = tx.computeUnits;

    const m = await readMarket(program, market);
    expect(m.creator.toBase58()).to.equal(creator.publicKey.toBase58());
    expect(m.resolver.toBase58()).to.equal(resolver.publicKey.toBase58());
    expect(m.collateralMint.toBase58()).to.equal(mint.toBase58());
    expect(m.vault.toBase58()).to.equal(vault.toBase58());
    expect(m.question).to.equal(question);
    expect(Buffer.from(m.questionHash).toString("hex")).to.equal(
      sha256(question).toString("hex")
    );
    expect(m.b.toString()).to.equal(B.toString());
    expect(m.qYes.toString()).to.equal("0");
    expect(m.qNo.toString()).to.equal("0");
    expect(m.statusKey).to.equal("open");
    expect(m.winner).to.equal(null);
    expect(m.closeTime.toString()).to.equal(closeTime.toString());

    const vaultBalance = await tokenBalance(vault);
    expect(vaultBalance.toString(), "vault seed is not b*ln2").to.equal(seed.toString());
    // The literal, for the scale the local suite also uses — so a change in
    // `bLn2Floor` cannot make both sides of the comparison wrong together.
    if (B === 100_000_000n) expect(vaultBalance.toString()).to.equal("69314718");
    if (B === 10_000_000n) expect(vaultBalance.toString()).to.equal("6931471");

    const ev = requireEvent(tx, "marketCreated");
    expect(big(ev.seedAmount).toString()).to.equal(vaultBalance.toString());
    expect(big(ev.b).toString()).to.equal(B.toString());
  });

  it("rejects a buy whose min_shares_out cannot be met (slippage, on devnet)", async function () {
    this.timeout(180_000);
    // 1 unit of collateral cannot possibly buy 10^12 shares.
    await expectError(
      sendExpectingFailure(
        program.methods.buyShares(outcomeArg("yes"), bn(SPEND_A), bn(1_000_000_000_000n)).accountsPartial({
          buyer: a.publicKey,
          market,
          position: posA,
          vault,
          buyerTokenAccount: ataA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }),
        [a]
      ),
      ERR.SlippageExceeded,
      "buy with an unreachable min_shares_out"
    );
    const m = await readMarket(program, market);
    expect(m.qYes.toString(), "a reverted buy moved q_yes").to.equal("0");
  });

  it("buy YES as A: shares credited, q_yes moves, vault up by exactly the collateral paid", async function () {
    this.timeout(300_000);
    const spend = SPEND_A;

    const walletBefore = await tokenBalance(ataA);
    const vaultBefore = await tokenBalance(vault);
    const before = await readMarket(program, market);

    const tx = await record(
      program,
      program.methods.buyShares(outcomeArg("yes"), bn(spend), bn(0)).accountsPartial({
        buyer: a.publicKey,
        market,
        position: posA,
        vault,
        buyerTokenAccount: ataA,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }),
      [a],
      "buy_shares (A, YES, init position)"
    );
    ledger.in(spend);
    cu["buy_shares (first buy: position init_if_needed)"] = tx.computeUnits;

    const ev = requireEvent(tx, "sharesBought");
    sharesA = big(ev.sharesOut);
    expect(sharesA > 0n).to.equal(true);
    expect(big(ev.collateralIn).toString()).to.equal(spend.toString());

    const after = await readMarket(program, market);
    expect((after.qYes - before.qYes).toString()).to.equal(sharesA.toString());
    expect(after.qNo.toString()).to.equal(before.qNo.toString());

    const pos = await readPosition(program, posA);
    expect(pos.yesShares.toString()).to.equal(sharesA.toString());
    expect(pos.noShares.toString()).to.equal("0");
    expect(pos.owner.toBase58()).to.equal(a.publicKey.toBase58());
    expect(pos.market.toBase58()).to.equal(market.toBase58());

    expect(((await tokenBalance(vault)) - vaultBefore).toString()).to.equal(spend.toString());
    expect((walletBefore - (await tokenBalance(ataA))).toString()).to.equal(spend.toString());

    priceAfter.push(big(ev.priceYesAfter));
    expect(priceAfter[0] > UNIT / 2n, "buying YES did not push price above 0.5").to.equal(true);

    await assertSolvent("after A buys YES");
  });

  it("buy NO as B: price_yes moves the other way", async function () {
    this.timeout(300_000);
    const spend = SPEND_B;
    const vaultBefore = await tokenBalance(vault);
    const before = await readMarket(program, market);

    const tx = await record(
      program,
      program.methods.buyShares(outcomeArg("no"), bn(spend), bn(0)).accountsPartial({
        buyer: b.publicKey,
        market,
        position: posB,
        vault,
        buyerTokenAccount: ataB,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }),
      [b],
      "buy_shares (B, NO)"
    );
    ledger.in(spend);

    const ev = requireEvent(tx, "sharesBought");
    sharesB = big(ev.sharesOut);
    const after = await readMarket(program, market);
    expect((after.qNo - before.qNo).toString()).to.equal(sharesB.toString());
    expect(after.qYes.toString()).to.equal(before.qYes.toString());
    expect(((await tokenBalance(vault)) - vaultBefore).toString()).to.equal(spend.toString());

    priceAfter.push(big(ev.priceYesAfter));
    expect(
      priceAfter[1] < priceAfter[0],
      `buying NO did not lower price_yes (${priceAfter[0]} -> ${priceAfter[1]})`
    ).to.equal(true);

    await assertSolvent("after B buys NO");
  });

  it("buy more YES as C: price_yes rises again and ends above where it started", async function () {
    this.timeout(300_000);
    const spend = SPEND_C;
    const vaultBefore = await tokenBalance(vault);
    const before = await readMarket(program, market);

    const tx = await record(
      program,
      program.methods.buyShares(outcomeArg("yes"), bn(spend), bn(0)).accountsPartial({
        buyer: c.publicKey,
        market,
        position: posC,
        vault,
        buyerTokenAccount: ataC,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }),
      [c],
      "buy_shares (C, YES)"
    );
    ledger.in(spend);

    const ev = requireEvent(tx, "sharesBought");
    sharesC = big(ev.sharesOut);
    const after = await readMarket(program, market);
    expect((after.qYes - before.qYes).toString()).to.equal(sharesC.toString());
    expect(((await tokenBalance(vault)) - vaultBefore).toString()).to.equal(spend.toString());

    priceAfter.push(big(ev.priceYesAfter));
    expect(priceAfter[2] > priceAfter[1]).to.equal(true);
    expect(priceAfter[2] > priceAfter[0]).to.equal(true);
    expect(priceAfter.every((p) => p > 0n && p < UNIT)).to.equal(true);

    await assertSolvent("after C buys YES");
  });

  it("sell part of A's position: collateral returned, position and q debited exactly", async function () {
    this.timeout(300_000);
    const toSell = sharesA / 2n;
    expect(toSell > 0n).to.equal(true);

    const walletBefore = await tokenBalance(ataA);
    const vaultBefore = await tokenBalance(vault);
    const before = await readMarket(program, market);
    const posBefore = await readPosition(program, posA);

    const tx = await record(
      program,
      program.methods.sellShares(outcomeArg("yes"), bn(toSell), bn(0)).accountsPartial({
        seller: a.publicKey,
        market,
        position: posA,
        vault,
        sellerTokenAccount: ataA,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      [a],
      "sell_shares (A, half of YES)"
    );
    cu["sell_shares"] = tx.computeUnits;

    const ev = requireEvent(tx, "sharesSold");
    const proceeds = big(ev.collateralOut);
    expect(proceeds > 0n).to.equal(true);
    ledger.out(proceeds);
    sharesA -= toSell;

    expect(((await tokenBalance(ataA)) - walletBefore).toString()).to.equal(proceeds.toString());
    expect((vaultBefore - (await tokenBalance(vault))).toString()).to.equal(proceeds.toString());

    const posAfter = await readPosition(program, posA);
    expect((posBefore.yesShares - posAfter.yesShares).toString()).to.equal(toSell.toString());
    expect(posAfter.yesShares.toString()).to.equal(sharesA.toString());

    const after = await readMarket(program, market);
    expect((before.qYes - after.qYes).toString()).to.equal(toSell.toString());
    expect(proceeds < SPEND_A, "round trip paid out more than it took in").to.equal(true);

    await assertSolvent("after A sells half");
  });

  it("rejects close_market before close_time, then closes after a real wall-clock wait", async function () {
    this.timeout(600_000);

    const now = await onChainUnixTime();
    if (now < closeTime) {
      await expectError(
        sendExpectingFailure(program.methods.closeMarket().accountsPartial({ market }), []),
        ERR.CloseTimeNotReached,
        "close before close_time"
      );
    } else {
      // eslint-disable-next-line no-console
      console.log("    [note] close_time already passed; skipped the early-close check");
    }

    await waitForOnChainTime(closeTime);

    const tx = await record(
      program,
      program.methods.closeMarket().accountsPartial({ market }),
      [],
      "close_market"
    );
    cu["close_market"] = tx.computeUnits;
    const ev = requireEvent(tx, "marketClosed");
    expect(big(ev.closeTime).toString()).to.equal(closeTime.toString());

    const m = await readMarket(program, market);
    expect(m.statusKey).to.equal("closed");
    expect(m.winner).to.equal(null);

    await assertSolvent("after close");
  });

  /**
   * Plan §4.3's fourth exit criterion, verified on devnet rather than only on
   * the local validator.
   *
   * `resolve_market` enforces the authority with `has_one = resolver`, an
   * *account constraint*, so it is checked inside `try_accounts` before the
   * handler's status checks ever run. That is why both of these come back as
   * `Unauthorized` (6006) and not as some status error — and why the market is
   * still `Closed` afterwards.
   */
  it("resolver access control: a stranger and the creator are both rejected", async function () {
    this.timeout(300_000);

    const impostor = feePayer(); // the treasury: funded, signs, but is not the resolver
    await expectError(
      sendExpectingFailure(
        program.methods
          .resolveMarket(outcomeArg("no"))
          .accountsPartial({ market, resolver: impostor.publicKey }),
        []
      ),
      ERR.Unauthorized,
      "resolve as a stranger"
    );

    await expectError(
      sendExpectingFailure(
        program.methods
          .resolveMarket(outcomeArg("no"))
          .accountsPartial({ market, resolver: creator.publicKey }),
        [creator]
      ),
      ERR.Unauthorized,
      "resolve as the market creator"
    );

    const m = await readMarket(program, market);
    expect(m.statusKey, "a rejected resolve changed the status").to.equal("closed");
    expect(m.winner).to.equal(null);
  });

  it("resolves YES as the designated resolver", async function () {
    this.timeout(300_000);
    const tx = await record(
      program,
      program.methods
        .resolveMarket(outcomeArg("yes"))
        .accountsPartial({ market, resolver: resolver.publicKey }),
      [resolver],
      "resolve_market (YES)"
    );
    cu["resolve_market"] = tx.computeUnits;
    expect(Object.keys(requireEvent(tx, "marketResolved").winningOutcome)[0]).to.equal("yes");

    const m = await readMarket(program, market);
    expect(m.statusKey).to.equal("resolved");
    expect(m.winner).to.equal("yes");

    await assertSolvent("after resolve");
  });

  it("redeems winners 1:1 and the loser for zero, closing every position", async function () {
    this.timeout(600_000);
    const m = await readMarket(program, market);
    const qYesAtResolution = m.qYes;

    // --- A (winner, partially unwound) ---
    {
      const walletBefore = await tokenBalance(ataA);
      const tx = await record(
        program,
        program.methods.redeem().accountsPartial({
          owner: a.publicKey,
          market,
          position: posA,
          vault,
          ownerTokenAccount: ataA,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        [a],
        "redeem (A, winner)"
      );
      cu["redeem (winner, pays out)"] = tx.computeUnits;
      const payout = big(requireEvent(tx, "redeemed").payout);
      expect(payout.toString(), "winner not paid 1:1").to.equal(sharesA.toString());
      expect(((await tokenBalance(ataA)) - walletBefore).toString()).to.equal(payout.toString());
      expect(await positionExists(posA), "position was not closed").to.equal(false);
      ledger.out(payout);
      payouts += payout;
      await assertSolvent("after A redeems");
    }

    // --- C (winner) ---
    {
      const walletBefore = await tokenBalance(ataC);
      const tx = await record(
        program,
        program.methods.redeem().accountsPartial({
          owner: c.publicKey,
          market,
          position: posC,
          vault,
          ownerTokenAccount: ataC,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        [c],
        "redeem (C, winner)"
      );
      const payout = big(requireEvent(tx, "redeemed").payout);
      expect(payout.toString(), "winner not paid 1:1").to.equal(sharesC.toString());
      expect(((await tokenBalance(ataC)) - walletBefore).toString()).to.equal(payout.toString());
      expect(await positionExists(posC)).to.equal(false);
      ledger.out(payout);
      payouts += payout;
      await assertSolvent("after C redeems");
    }

    // --- B (loser: paid zero, position still cleared and rent returned) ---
    {
      const walletBefore = await tokenBalance(ataB);
      const lamportsBefore = await getConnection().getBalance(b.publicKey, COMMITMENT);
      const tx = await record(
        program,
        program.methods.redeem().accountsPartial({
          owner: b.publicKey,
          market,
          position: posB,
          vault,
          ownerTokenAccount: ataB,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        [b],
        "redeem (B, loser)"
      );
      cu["redeem (loser, no transfer)"] = tx.computeUnits;
      const ev = requireEvent(tx, "redeemed");
      expect(big(ev.payout).toString(), "loser was paid something").to.equal("0");
      expect(big(ev.losingShares).toString()).to.equal(sharesB.toString());
      expect(big(ev.winningShares).toString()).to.equal("0");
      expect((await tokenBalance(ataB)).toString()).to.equal(walletBefore.toString());
      expect(await positionExists(posB), "loser's position was not closed").to.equal(false);
      const lamportsAfter = await getConnection().getBalance(b.publicKey, COMMITMENT);
      // The loser is not the fee payer here (the treasury is), so the rent
      // refund arrives undiluted — locally the same assertion holds for the
      // same reason.
      expect(lamportsAfter > lamportsBefore, "loser did not get their rent back").to.equal(true);
      await assertSolvent("after B redeems");
    }

    // --- a second redeem hits a closed account, not NothingToRedeem ---
    await expectError(
      sendExpectingFailure(
        program.methods.redeem().accountsPartial({
          owner: a.publicKey,
          market,
          position: posA,
          vault,
          ownerTokenAccount: ataA,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        [a]
      ),
      LANG_ERR.AccountNotInitialized,
      "redeem twice"
    );

    // --- residual ---
    const residual = await tokenBalance(vault);
    expect(residual.toString(), "residual breaks the collateral identity").to.equal(
      ledger.expected.toString()
    );
    expect(payouts.toString(), "total payout != q_yes at resolution").to.equal(
      qYesAtResolution.toString()
    );
    expect(residual >= 0n).to.equal(true);
    expect(residual <= seed, `residual ${residual} exceeds the b*ln2 seed ${seed}`).to.equal(true);

    for (const [name, used] of Object.entries(cu)) {
      if (used === null) continue;
      expect(used < 200_000, `${name} used ${used} CU, at or past the default budget`).to.equal(
        true
      );
    }

    // --- evidence ---
    const run = {
      cluster: "devnet",
      rpc: process.env.ANCHOR_PROVIDER_URL,
      programId: program.programId.toBase58(),
      collateralPath: manifest.collateralPath,
      isRealCircleUsdc: manifest.isRealCircleUsdc,
      mint: manifest.mint,
      question,
      market: market.toBase58(),
      vault: vault.toBase58(),
      creator: creator.publicKey.toBase58(),
      resolver: resolver.publicKey.toBase58(),
      closeTime,
      closeWindowSeconds: CLOSE_WINDOW_S,
      accounting: {
        b: B.toString(),
        seed: seed.toString(),
        collateralIn: ledger.inflow.toString(),
        collateralOut: ledger.outflow.toString(),
        payouts: payouts.toString(),
        qYesAtResolution: qYesAtResolution.toString(),
        qNoAtResolution: m.qNo.toString(),
        residual: residual.toString(),
      },
      computeUnits: cu,
      steps: steps.map((s) => ({ ...s, explorer: explorer(s.signature) })),
      finishedAt: new Date().toISOString(),
    };
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(RUN_LOG, JSON.stringify(run, null, 2));

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "  ---- devnet lifecycle vault accounting (base units, 1e-6) ----",
        `  b                       = ${B}`,
        `  seed (b*ln2)            = ${seed}`,
        `  collateral in           = ${ledger.inflow}`,
        `  collateral out          = ${ledger.outflow}`,
        `    of which payouts      = ${payouts}`,
        `  q_yes at resolution     = ${qYesAtResolution}`,
        `  q_no  at resolution     = ${m.qNo}`,
        `  RESIDUAL in vault       = ${residual}`,
        "",
        "  ---- compute units per instruction (whole instruction) ----",
        ...Object.entries(cu).map(
          ([k, v]) =>
            `  ${k.padEnd(46)} = ${v === null ? "n/a" : v}` +
            `${v === null ? "" : ` (${((v / 200_000) * 100).toFixed(1)}% of the 200,000 default)`}`
        ),
        "",
        "  ---- transaction signatures ----",
        ...steps.map((s) => `  ${s.step.padEnd(34)} ${s.signature}`),
        "",
        `  run log: ${RUN_LOG}`,
        "",
      ].join("\n")
    );
  });

  it("leaves nothing owed: every position is gone and the vault never went negative", async function () {
    this.timeout(120_000);
    const m = await readMarket(program, market);
    expect(await positionExists(posA)).to.equal(false);
    expect(await positionExists(posB)).to.equal(false);
    expect(await positionExists(posC)).to.equal(false);
    expect((await tokenBalance(vault)) >= 0n).to.equal(true);
    expect(maxBig(m.qYes, m.qNo) > 0n).to.equal(true);
  });

  /**
   * The vault bookkeeping identity plus the obligation cover, exactly as
   * `tests/utils.ts#assertSolvent` states them. Duplicated here rather than
   * imported only because it needs the retry-wrapped readers above; the claims
   * and the tolerances (zero) are identical.
   */
  async function assertSolvent(label: string): Promise<void> {
    const balance = await tokenBalance(vault);
    const m = await readMarket(program, market);
    expect(balance.toString(), `${label}: vault bookkeeping`).to.equal(ledger.expected.toString());
    const obligation = maxBig(m.qYes, m.qNo);
    expect(
      balance >= obligation,
      `${label}: vault ${balance} does not cover max obligation ${obligation}`
    ).to.equal(true);
  }
});
