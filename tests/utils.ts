/**
 * tests/utils.ts — shared fixtures for the T09 local-validator suite.
 *
 * Everything here is hermetic (docs/DESIGN_DECISIONS.md D3): the suite creates
 * its **own** 6-decimal SPL mint and mints freely. Nothing depends on a faucet
 * for collateral; SOL for rent/fees comes from the local validator's airdrop,
 * which is a property of the validator, not of the collateral model.
 *
 * Three things in here exist because the program's shape forces them:
 *
 * 1. **The market PDA cannot be auto-derived.** Anchor's IDL has no vocabulary
 *    for a hashed seed, so `create_market`'s `market` account carries no `pda`
 *    metadata (see `create_market.rs`'s doc comment). `deriveMarket` does it by
 *    hand: `sha256` over the *raw UTF-8 question bytes* — no normalisation, no
 *    length prefix, no lowercasing.
 * 2. **Prices are only observable through events.** `Market` stores `q_yes` /
 *    `q_no` but no price, so exact price parity against the oracle has to come
 *    from the `SharesBought` / `SharesSold` events. `rpcWithEvents` sends a
 *    transaction and hands back its decoded events (and its compute usage).
 * 3. **There is no clock warp on `solana-test-validator`.** `close_time` is
 *    real wall time, so `waitForOnChainTime` polls the `Clock` sysvar — the
 *    exact value the program compares against — rather than sleeping blind.
 */

import * as anchor from "@anchor-lang/core";
import { AnchorProvider, BN, EventParser, Program, Wallet } from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Greekbet } from "../target/types/greekbet";

// ---------------------------------------------------------------------------
// Constants (docs/DESIGN_DECISIONS.md D4 / reference/README.md "Units")
// ---------------------------------------------------------------------------

export const DECIMALS = 6;
export const UNIT = 1_000_000n;
export const B_MIN = 10_000_000n; // 10 USDC
export const B_MAX = 1_000_000_000_000n; // 1,000,000 USDC
export const MAX_Q = 1_000_000_000_000_000n; // 1e9 shares
export const MAX_QUESTION_LEN = 200;

export const MARKET_SEED = Buffer.from("market");
export const VAULT_SEED = Buffer.from("vault");
export const POSITION_SEED = Buffer.from("position");

/**
 * `GreekBetError` discriminants. Anchor numbers custom errors from 6000 in
 * declaration order (`programs/greekbet/src/errors.rs`), and `errors.rs` pins
 * the first and last in a Rust unit test so a reorder breaks the build.
 *
 * `assertIdlErrorCodesMatch` re-checks this table against the freshly built
 * IDL, so a silent renumbering cannot make a negative test pass for the wrong
 * reason.
 */
export const ERR = {
  MarketNotOpen: 6000,
  MarketNotClosed: 6001,
  MarketNotResolved: 6002,
  MarketAlreadyResolved: 6003,
  CloseTimeNotReached: 6004,
  CloseTimeInPast: 6005,
  Unauthorized: 6006,
  BOutOfRange: 6007,
  QOutOfRange: 6008,
  SlippageExceeded: 6009,
  InsufficientShares: 6010,
  ZeroCostTrade: 6011,
  InvalidMint: 6012,
  InvalidVault: 6013,
  InvalidMintDecimals: 6014,
  VaultInsolvent: 6015,
  QuestionTooLong: 6016,
  NothingToRedeem: 6017,
  MathOverflow: 6018,
  DivByZero: 6019,
  InvalidInput: 6020,
} as const;

/**
 * Anchor framework (`LangErrorCode`) codes the suite asserts against.
 *
 * `AccountNotInitialized` is the one that matters: a **second `redeem` fails
 * with 3012, not with `NothingToRedeem`**, because `redeem` carries
 * `close = owner` on the position account, so the account is gone by the time
 * the second call tries to deserialise it. `NothingToRedeem` is still
 * reachable — see `negative.ts` — but only for a position that still exists
 * and holds 0/0.
 */
export const LANG_ERR = {
  ConstraintSeeds: 2006,
  ConstraintAddress: 2012,
  AccountNotInitialized: 3012,
  AccountNotSigner: 3010,
} as const;

/**
 * Typed as the literal, not as `Commitment`, on purpose: `getTransaction`
 * takes the narrower `Finality`, and a widened `Commitment` does not fit it.
 */
export const COMMITMENT = "confirmed" as const;

// ---------------------------------------------------------------------------
// Provider / program
// ---------------------------------------------------------------------------

let _provider: AnchorProvider | undefined;

/**
 * A provider pinned to `confirmed`.
 *
 * `AnchorProvider.env()`'s default options are `processed`, under which an
 * account read immediately after `rpc()` can legitimately return the *old*
 * state. Every assertion in this suite is "send a transaction, then read the
 * account", so that default would make the whole suite intermittently wrong.
 */
export function getProvider(): AnchorProvider {
  if (_provider) return _provider;
  const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  const walletPath =
    process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config", "solana", "id.json");
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8")));
  const wallet = new Wallet(Keypair.fromSecretKey(secret));
  const connection = new Connection(url, COMMITMENT);
  _provider = new AnchorProvider(connection, wallet, {
    commitment: COMMITMENT,
    preflightCommitment: COMMITMENT,
  });
  anchor.setProvider(_provider);
  return _provider;
}

export function getConnection(): Connection {
  return getProvider().connection;
}

export function getProgram(): Program<Greekbet> {
  getProvider();
  return anchor.workspace.greekbet as Program<Greekbet>;
}

/** Guard: the table above must agree with the IDL that was actually built. */
export function assertIdlErrorCodesMatch(program: Program<Greekbet>): void {
  const fromIdl = new Map<string, number>();
  for (const e of (program.idl as any).errors ?? []) fromIdl.set(e.name, e.code);
  for (const [name, code] of Object.entries(ERR)) {
    const idlCode = fromIdl.get(name) ?? fromIdl.get(name[0].toLowerCase() + name.slice(1));
    expect(idlCode, `IDL has no error named ${name}`).to.not.equal(undefined);
    expect(idlCode, `error code drift for ${name}`).to.equal(code);
  }
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export function bn(v: bigint | number | string): BN {
  return new BN(v.toString());
}

export function big(v: any): bigint {
  if (typeof v === "bigint") return v;
  if (v && typeof v.toString === "function") return BigInt(v.toString());
  return BigInt(v);
}

/**
 * `floor(b · ln 2)` — the vault seed `create_market` deposits, computed as
 * `lmsr::cost(0, 0, b)` on chain.
 *
 * ln 2 to 40 decimal places, applied in exact integer arithmetic. The value is
 * cross-checked against `reference/vectors/trades.json`'s `cost_initial` for
 * all six `b` decades in `parity.ts`, so this is not an independent guess —
 * it is pinned to the oracle.
 */
const LN2_1E40 = 6931471805599453094172321214581765680755n;

export function bLn2Floor(b: bigint): bigint {
  return (b * LN2_1E40) / 10n ** 40n;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

/** SHA-256 of the **raw UTF-8 bytes**. No normalisation, no length prefix. */
export function sha256(s: string): Buffer {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest();
}

/**
 * The market PDA, derived by hand.
 *
 * Anchor cannot express `sha256(<instruction arg>)` as an IDL seed, so
 * `create_market`'s `market` account has no `pda` metadata and `.accounts()`
 * cannot resolve it. Vault and position *do* keep their metadata, but this
 * suite passes every account explicitly anyway so that a resolver change can
 * never silently alter what is being tested.
 */
export function deriveMarket(
  programId: PublicKey,
  creator: PublicKey,
  question: string
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MARKET_SEED, creator.toBuffer(), sha256(question)],
    programId
  );
}

export function deriveVault(programId: PublicKey, market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED, market.toBuffer()], programId);
}

export function derivePosition(
  programId: PublicKey,
  market: PublicKey,
  owner: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POSITION_SEED, market.toBuffer(), owner.toBuffer()],
    programId
  );
}

// ---------------------------------------------------------------------------
// Wallets and collateral
// ---------------------------------------------------------------------------

let _questionCounter = 0;
const RUN_ID = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** A question string unique to this process, so re-runs never collide on a PDA. */
export function uniqueQuestion(label: string): string {
  _questionCounter += 1;
  const q = `${label} #${_questionCounter} [${RUN_ID}]`;
  if (Buffer.byteLength(q, "utf8") > MAX_QUESTION_LEN) {
    throw new Error(`question too long for the account: ${q}`);
  }
  return q;
}

/** Airdrop, in chunks, because the validator faucet caps a single request. */
export async function airdrop(to: PublicKey, sol: number): Promise<void> {
  const connection = getConnection();
  let remaining = sol;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 100);
    const sig = await connection.requestAirdrop(to, chunk * LAMPORTS_PER_SOL);
    const bh = await connection.getLatestBlockhash(COMMITMENT);
    await connection.confirmTransaction({ signature: sig, ...bh }, COMMITMENT);
    remaining -= chunk;
  }
}

export async function fundedKeypair(sol = 20): Promise<Keypair> {
  const kp = Keypair.generate();
  await airdrop(kp.publicKey, sol);
  return kp;
}

export async function fundedKeypairs(n: number, sol = 20): Promise<Keypair[]> {
  const out: Keypair[] = [];
  for (let i = 0; i < n; i += 1) out.push(await fundedKeypair(sol));
  return out;
}

let _bank: Keypair | undefined;

/** Fee payer / mint authority for all SPL-token setup work. */
export async function bank(): Promise<Keypair> {
  if (_bank) return _bank;
  _bank = await fundedKeypair(500);
  return _bank;
}

export interface Collateral {
  mint: PublicKey;
  authority: Keypair;
  decimals: number;
}

/**
 * A throwaway SPL mint (D3). `decimals` defaults to 6 — the only value
 * `create_market` accepts; a different one is used deliberately by the
 * `InvalidMintDecimals` negative test.
 */
export async function createCollateralMint(decimals = DECIMALS): Promise<Collateral> {
  const payer = await bank();
  const authority = payer;
  const mint = await createMint(
    getConnection(),
    payer,
    authority.publicKey,
    null,
    decimals,
    undefined,
    { commitment: COMMITMENT },
    TOKEN_PROGRAM_ID
  );
  return { mint, authority, decimals };
}

export async function tokenAccountFor(
  collateral: Collateral,
  owner: PublicKey
): Promise<PublicKey> {
  const payer = await bank();
  const acc = await getOrCreateAssociatedTokenAccount(
    getConnection(),
    payer,
    collateral.mint,
    owner,
    false,
    COMMITMENT,
    { commitment: COMMITMENT },
    TOKEN_PROGRAM_ID
  );
  return acc.address;
}

export async function mintCollateral(
  collateral: Collateral,
  to: PublicKey,
  amount: bigint
): Promise<void> {
  const payer = await bank();
  await mintTo(
    getConnection(),
    payer,
    collateral.mint,
    to,
    collateral.authority,
    amount,
    [],
    { commitment: COMMITMENT },
    TOKEN_PROGRAM_ID
  );
}

/** Create a wallet, give it an ATA on `collateral`, and mint it `amount`. */
export async function fundedTrader(
  collateral: Collateral,
  amount: bigint,
  sol = 20
): Promise<{ keypair: Keypair; tokenAccount: PublicKey }> {
  const keypair = await fundedKeypair(sol);
  const tokenAccount = await tokenAccountFor(collateral, keypair.publicKey);
  if (amount > 0n) await mintCollateral(collateral, tokenAccount, amount);
  return { keypair, tokenAccount };
}

export async function tokenBalance(tokenAccount: PublicKey): Promise<bigint> {
  const acc = await getAccount(getConnection(), tokenAccount, COMMITMENT, TOKEN_PROGRAM_ID);
  return acc.amount;
}

// ---------------------------------------------------------------------------
// Account readers
// ---------------------------------------------------------------------------

export type Status = "open" | "closed" | "resolved";
export type Side = "yes" | "no";

export interface MarketState {
  creator: PublicKey;
  resolver: PublicKey;
  collateralMint: PublicKey;
  vault: PublicKey;
  questionHash: Buffer;
  question: string;
  createdAt: bigint;
  closeTime: bigint;
  b: bigint;
  qYes: bigint;
  qNo: bigint;
  status: Status;
  winningOutcome: Side | null;
  bump: number;
  vaultBump: number;
}

function enumKey(v: any): string {
  return Object.keys(v)[0];
}

export async function readMarket(
  program: Program<Greekbet>,
  market: PublicKey
): Promise<MarketState> {
  const raw: any = await (program.account as any).market.fetch(market, COMMITMENT);
  return {
    creator: raw.creator,
    resolver: raw.resolver,
    collateralMint: raw.collateralMint,
    vault: raw.vault,
    questionHash: Buffer.from(raw.questionHash),
    question: raw.question,
    createdAt: big(raw.createdAt),
    closeTime: big(raw.closeTime),
    b: big(raw.b),
    qYes: big(raw.qYes),
    qNo: big(raw.qNo),
    status: enumKey(raw.status) as Status,
    winningOutcome: raw.winningOutcome === null ? null : (enumKey(raw.winningOutcome) as Side),
    bump: raw.bump,
    vaultBump: raw.vaultBump,
  };
}

export interface PositionState {
  market: PublicKey;
  owner: PublicKey;
  yesShares: bigint;
  noShares: bigint;
  bump: number;
}

export async function readPosition(
  program: Program<Greekbet>,
  position: PublicKey
): Promise<PositionState> {
  const raw: any = await (program.account as any).userPosition.fetch(position, COMMITMENT);
  return {
    market: raw.market,
    owner: raw.owner,
    yesShares: big(raw.yesShares),
    noShares: big(raw.noShares),
    bump: raw.bump,
  };
}

export async function positionExists(position: PublicKey): Promise<boolean> {
  const info = await getConnection().getAccountInfo(position, COMMITMENT);
  return info !== null && info.data.length > 0;
}

/** `{ yes: {} }` / `{ no: {} }` — how Anchor encodes a fieldless enum arg. */
export function outcomeArg(side: Side): any {
  return side === "yes" ? { yes: {} } : { no: {} };
}

// ---------------------------------------------------------------------------
// Sending, and reading back what the program emitted
// ---------------------------------------------------------------------------

export interface SentTx {
  signature: string;
  logs: string[];
  events: Record<string, any>;
  computeUnits: number | null;
}

async function getTransactionWithRetry(signature: string, attempts = 25): Promise<any> {
  const connection = getConnection();
  for (let i = 0; i < attempts; i += 1) {
    const tx = await connection.getTransaction(signature, {
      commitment: COMMITMENT,
      maxSupportedTransactionVersion: 0,
    });
    if (tx?.meta?.logMessages) return tx;
    await sleep(200);
  }
  throw new Error(`transaction ${signature} never became readable at ${COMMITMENT}`);
}

/**
 * Send a `methods` builder and decode the events it emitted.
 *
 * The events are the only place a price is observable — `Market` stores `q`
 * but not `price_yes` — so `parity.ts` needs this to assert exact price
 * equality against `reference/vectors/trades.json`.
 */
export async function rpcWithEvents(
  program: Program<Greekbet>,
  builder: any,
  signers: Keypair[] = []
): Promise<SentTx> {
  const b = signers.length > 0 ? builder.signers(signers) : builder;
  const signature: string = await b.rpc({
    commitment: COMMITMENT,
    preflightCommitment: COMMITMENT,
  });
  const tx = await getTransactionWithRetry(signature);
  const logs: string[] = tx.meta.logMessages;
  const parser = new EventParser(program.programId, program.coder);
  const events: Record<string, any> = {};
  for (const ev of parser.parseLogs(logs)) {
    events[ev.name] = ev.data;
    // Tolerate either casing so a change in Anchor's IDL case conversion does
    // not silently make every event lookup return `undefined`.
    events[ev.name[0].toLowerCase() + ev.name.slice(1)] = ev.data;
    events[ev.name[0].toUpperCase() + ev.name.slice(1)] = ev.data;
  }
  let computeUnits: number | null = null;
  for (const line of logs) {
    const m = /consumed (\d+) of \d+ compute units/.exec(line);
    if (m && line.includes(program.programId.toBase58())) computeUnits = Number(m[1]);
  }
  return { signature, logs, events, computeUnits };
}

export function requireEvent(tx: SentTx, name: string): any {
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
 * Pull a numeric error code out of whatever Anchor/web3.js threw.
 *
 * Three shapes show up in practice: a decoded `AnchorError` (custom program
 * errors that the IDL knows about), a `SendTransactionError` whose message
 * carries `custom program error: 0x...` (anything preflight rejects before
 * Anchor gets to translate it), and a framework `LangError` such as
 * `AccountNotInitialized`.
 */
export function errorCodeOf(err: any): number | null {
  const direct = err?.error?.errorCode?.number;
  if (typeof direct === "number") return direct;
  if (typeof err?.code === "number" && err.code >= 100) return err.code;

  const logs: string[] = err?.logs ?? err?.transactionLogs ?? [];
  const text = [String(err?.message ?? ""), ...logs].join("\n");

  const named = /Error Number: (\d+)/.exec(text);
  if (named) return Number(named[1]);

  const custom = /custom program error: (0x[0-9a-fA-F]+|\d+)/.exec(text);
  if (custom) {
    return custom[1].startsWith("0x") ? parseInt(custom[1], 16) : parseInt(custom[1], 10);
  }
  return null;
}

/** Assert a call fails with a **specific** code, not merely that it fails. */
export async function expectError(
  promise: Promise<any>,
  expectedCode: number,
  what: string
): Promise<any> {
  let threw = false;
  let caught: any;
  try {
    await promise;
  } catch (err) {
    threw = true;
    caught = err;
  }
  expect(threw, `${what}: expected error ${expectedCode} but the call succeeded`).to.equal(true);
  const code = errorCodeOf(caught);
  if (code !== expectedCode) {
    const logs: string[] = caught?.logs ?? [];
    throw new Error(
      `${what}: expected error code ${expectedCode}, got ${code}\n` +
        `message: ${caught?.message}\n` +
        (logs.length ? `logs:\n  ${logs.join("\n  ")}` : "")
    );
  }
  return caught;
}

// ---------------------------------------------------------------------------
// Time — there is no clock warp on solana-test-validator
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * `Clock::unix_timestamp` as the *program* sees it.
 *
 * Read from the `Clock` sysvar rather than from the host wall clock: the two
 * can drift on a local validator, and every `close_time` comparison in the
 * program is against this value.
 */
export async function onChainUnixTime(): Promise<number> {
  const info = await getConnection().getAccountInfo(SYSVAR_CLOCK_PUBKEY, COMMITMENT);
  if (!info) throw new Error("could not read the Clock sysvar");
  return Number(info.data.readBigInt64LE(32));
}

/** Wait until the *on-chain* clock has reached `ts`. */
export async function waitForOnChainTime(ts: number, budgetMs = 180_000): Promise<number> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const now = await onChainUnixTime();
    if (now >= ts) return now;
    if (Date.now() > deadline) {
      throw new Error(`on-chain clock never reached ${ts} (still ${now}) within ${budgetMs}ms`);
    }
    await sleep(Math.min(500, Math.max(150, (ts - now) * 100)));
  }
}

// ---------------------------------------------------------------------------
// Market fixture
// ---------------------------------------------------------------------------

export interface MarketFixture {
  program: Program<Greekbet>;
  collateral: Collateral;
  question: string;
  market: PublicKey;
  vault: PublicKey;
  creator: Keypair;
  creatorTokenAccount: PublicKey;
  resolver: Keypair;
  b: bigint;
  closeTime: number;
  seed: bigint;
  createTx: SentTx;
}

export interface CreateMarketOpts {
  b?: bigint;
  question?: string;
  closeTimeSecondsFromNow?: number;
  closeTimeAbsolute?: number;
  creator?: Keypair;
  creatorTokenAccount?: PublicKey;
  resolver?: Keypair;
  creatorFunding?: bigint;
}

/**
 * Create a market end-to-end: wallet, ATA, collateral, and the instruction.
 *
 * Returns the fixture *and* the `MarketCreated` event, so a caller can assert
 * against the seed the program actually computed rather than against a number
 * this file guessed.
 */
export async function createMarketFixture(
  collateral: Collateral,
  opts: CreateMarketOpts = {}
): Promise<MarketFixture> {
  const program = getProgram();
  const b = opts.b ?? 100_000_000n;
  const seed = bLn2Floor(b);
  const creator =
    opts.creator ??
    (await fundedKeypair(20));
  const creatorTokenAccount =
    opts.creatorTokenAccount ?? (await tokenAccountFor(collateral, creator.publicKey));
  if (opts.creatorTokenAccount === undefined) {
    await mintCollateral(collateral, creatorTokenAccount, opts.creatorFunding ?? seed * 4n + seed);
  }
  const resolver = opts.resolver ?? Keypair.generate();
  const question = opts.question ?? uniqueQuestion("Will the vault stay solvent?");
  const closeTime =
    opts.closeTimeAbsolute ??
    (await onChainUnixTime()) + (opts.closeTimeSecondsFromNow ?? 3600);

  const [market] = deriveMarket(program.programId, creator.publicKey, question);
  const [vault] = deriveVault(program.programId, market);

  const createTx = await rpcWithEvents(
    program,
    program.methods
      .createMarket(question, bn(closeTime), bn(b), resolver.publicKey)
      .accountsPartial({
        creator: creator.publicKey,
        market,
        collateralMint: collateral.mint,
        vault,
        creatorTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      }),
    [creator]
  );

  return {
    program,
    collateral,
    question,
    market,
    vault,
    creator,
    creatorTokenAccount,
    resolver,
    b,
    closeTime,
    seed,
    createTx,
  };
}

// ---------------------------------------------------------------------------
// Solvency
// ---------------------------------------------------------------------------

/**
 * Running collateral ledger for one market: what the vault *should* hold.
 *
 * `seed + Σ in − Σ out` is an exact identity — every base unit that enters or
 * leaves the vault does so through an instruction whose amount this suite
 * observes — so it is asserted with **zero tolerance**.
 */
export class VaultLedger {
  public inflow = 0n;
  public outflow = 0n;
  public readonly seed: bigint;

  // Written out rather than as a TypeScript parameter property: node's
  // built-in type stripping rejects those outright, and mocha will load a
  // `.ts` file through node's loader rather than ts-node whenever every one
  // of its imports happens to resolve as ESM. Keeping the syntax to the
  // strip-only subset means it does not matter which loader wins.
  constructor(seed: bigint) {
    this.seed = seed;
  }

  in(amount: bigint): void {
    this.inflow += amount;
  }

  out(amount: bigint): void {
    this.outflow += amount;
  }

  get expected(): bigint {
    return this.seed + this.inflow - this.outflow;
  }

  get net(): bigint {
    return this.inflow - this.outflow;
  }
}

/**
 * The solvency assertion, run after every state-changing step.
 *
 * Two independent claims:
 *
 * * **Bookkeeping.** The vault holds exactly `seed + Σ in − Σ out`. Anything
 *   else means collateral moved that no instruction accounted for.
 * * **Obligation cover.** The vault holds at least `max(q_yes, q_no)`. That is
 *   the largest payout the market could ever owe — resolution picks a side,
 *   winners redeem 1:1, and `q_win ≤ max(q_yes, q_no)`. This is the on-chain
 *   counterpart of T04's bounded-loss property, and it is what `create_market`
 *   depositing `b·ln 2` buys.
 */
export async function assertSolvent(
  program: Program<Greekbet>,
  fixture: { market: PublicKey; vault: PublicKey },
  ledger: VaultLedger,
  label: string
): Promise<{ vault: bigint; market: MarketState }> {
  const vault = await tokenBalance(fixture.vault);
  const market = await readMarket(program, fixture.market);
  expect(vault.toString(), `${label}: vault bookkeeping`).to.equal(ledger.expected.toString());
  const obligation = maxBig(market.qYes, market.qNo);
  expect(
    vault >= obligation,
    `${label}: vault ${vault} does not cover max obligation ${obligation}`
  ).to.equal(true);
  return { vault, market };
}
