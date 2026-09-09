/**
 * scripts/devnet/fund.ts — T10 step 3: get SOL and collateral into test wallets
 * on devnet, unattended.
 *
 *   NODE_OPTIONS=--no-experimental-strip-types \
 *     node_modules/.bin/ts-node -P tsconfig.json scripts/devnet/fund.ts
 *
 * Writes `~/.greekbet-devnet/funding.json`, which `tests/devnet/lifecycle.ts`
 * reads. Wallets and the fallback mint are **persisted and reused** across runs:
 * devnet SOL cannot be re-airdropped (see below), so every run that mints fresh
 * keypairs is SOL burnt for nothing.
 *
 * =========================================================================
 * WHICH COLLATERAL PATH IS IN USE — read this before believing any result
 * =========================================================================
 *
 * The ticket asks for three paths in order. What each one actually did:
 *
 * (a) **Circle's devnet faucet API — DOES NOT WORK unattended.**
 *     `https://faucet.circle.com/api/graphql` is a live Apollo endpoint with
 *     introspection disabled. Its drip mutation is
 *
 *         mutation ($input: RequestTokenInput!) {
 *           requestToken(input: $input) { __typename }
 *         }
 *         input RequestTokenInput {
 *           destinationAddress: String!
 *           blockchain: Blockchain!   # SOL
 *           token: Currency!          # USDC
 *         }
 *
 *     (recovered from the server's own "did you mean" validation errors). Sent
 *     with a correct payload it returns HTTP 200 and:
 *
 *         {"errors":[{"message":"ReCAPTCHA verification failed",
 *                     "extensions":{"code":"RECAPTCHA_ERROR"}}],"data":null}
 *
 *     The faucet's own client config confirms it: `recaptchaEnabled: true`,
 *     `reCaptchaThreshold: 0.7`, reCAPTCHA v3 site key
 *     `6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2`. A v3 token can only be minted
 *     by a real browser session that Google scores, so **no script can drip
 *     Circle USDC**. `tryCircleFaucet()` below still attempts it — if Circle
 *     ever drops the captcha this starts working with no other change — but it
 *     is expected to fail and its failure is not treated as an error.
 *
 *     The other documented route, `POST https://api.circle.com/v1/faucet/drips`,
 *     needs a Circle developer API key (`401 malformed authorization. Missing
 *     API key`). Set `CIRCLE_API_KEY` and this script will use it.
 *
 * (b) **Transfer from an already-funded treasury — works, needs one manual
 *     top-up.** If the treasury wallet holds Circle devnet USDC, that is what
 *     gets distributed and the run uses *real* devnet USDC. To enable it:
 *     open https://faucet.circle.com in a browser, pick Solana Devnet, paste the
 *     treasury pubkey, drip (10 USDC per request), then re-run. No code change.
 *
 * (c) **Custom 6-decimal mint — the fallback, and what runs unattended.**
 *     Plan §3 permits this explicitly ("A custom dummy token is an acceptable
 *     fallback if the faucet is unreliable during development") and D3 already
 *     uses it for the local suite. It exercises every code path the real mint
 *     would — same SPL Token program, same 6 decimals, same ATA derivation,
 *     same `transfer_checked` CPI, same `InvalidMintDecimals` guard — but it is
 *     **not** Circle USDC, and `funding.json` says so in `collateralPath` so
 *     nothing downstream can quietly claim otherwise.
 *
 * Force a path with `GB_COLLATERAL=circle|custom` (default: prefer circle when
 * the treasury actually holds some, else custom).
 *
 * =========================================================================
 * SOL
 * =========================================================================
 *
 * `solana airdrop` / `requestAirdrop` on devnet is rate-limited per source IP
 * and returned "airdrop request failed. This can happen when the rate limit is
 * reached" on every attempt from this host. There is **no retry loop** here for
 * the same reason there is none in setup.sh: the limiter is a spent quota, not
 * a transient. Test wallets are funded by `SystemProgram.transfer` from the
 * treasury instead, which is deterministic and costs 5000 lamports.
 */

import {
  clusterApiUrl,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transferChecked,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const DEVNET_RPC = process.env.ANCHOR_PROVIDER_URL ?? clusterApiUrl("devnet");
export const COMMITMENT = "confirmed" as const;

/** Circle's devnet USDC (docs/DESIGN_DECISIONS.md D3). Mint authority is Circle's. */
export const CIRCLE_USDC_DEVNET = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);

export const DECIMALS = 6;
export const UNIT = 1_000_000n;

export const STATE_DIR =
  process.env.GB_DEVNET_STATE ?? path.join(os.homedir(), ".greekbet-devnet");
export const FUNDING_FILE = path.join(STATE_DIR, "funding.json");
const WALLETS_DIR = path.join(STATE_DIR, "wallets");
const CUSTOM_MINT_FILE = path.join(STATE_DIR, "collateral-mint.json");

/** The four roles the lifecycle needs. `creator` also acts as the resolver's payer. */
export const ROLES = ["creator", "traderA", "traderB", "traderC"] as const;
export type Role = (typeof ROLES)[number];

/**
 * SOL per test wallet.
 *
 * The provider wallet (the treasury) is the fee payer for every instruction, so
 * a role wallet only pays rent for accounts where *it* is the Anchor `payer`:
 * `market` (417 B, ~0.0038 SOL) plus `vault` (165 B, ~0.0020) for the creator,
 * and `position` (89 B, ~0.0015) for each trader. 0.05 SOL is ~7x the worst
 * case and leaves room for a retried transaction.
 */
const SOL_PER_WALLET = 0.05;

export type CollateralPath = "circle-faucet" | "circle-treasury-transfer" | "custom-mint";

/**
 * How big the market is, per collateral path — and this is the whole reason the
 * two differ.
 *
 * On the custom mint we can print collateral, so the devnet run uses **exactly**
 * the parameters `tests/lifecycle.ts` uses locally (b = 100, spends of 10 / 4 /
 * 20). That makes the two runs directly comparable: identical inputs, so any
 * difference in `q_yes`, `q_no`, payouts or the residual is a real behavioural
 * difference between the validators rather than a difference in what was asked.
 *
 * On Circle's mint we cannot print anything. The faucet hands out **10 USDC per
 * drip**, so a 3,500-USDC fixture is unreachable; the market is scaled down to
 * `b = B_MIN` (10 USDC) and proportionally smaller trades, which fits in
 * **15 USDC total — two drips**. The lifecycle is the same lifecycle; only the
 * magnitudes shrink.
 */
export interface Scale {
  /** LMSR liquidity parameter, base units. */
  b: string;
  creatorFunding: string;
  traderFunding: string;
  /** What each trader spends on their buy, base units. */
  spendA: string;
  spendB: string;
  spendC: string;
}

const SCALES: Record<"circle" | "custom", Scale> = {
  // b = B_MIN = 10 USDC. Seed = floor(10e6 · ln2) = 6_931_471.
  // Total collateral required: 7.5 + 3 × 2.5 = 15 USDC.
  circle: {
    b: (10n * UNIT).toString(),
    creatorFunding: (7_500_000n).toString(),
    traderFunding: (2_500_000n).toString(),
    spendA: (1_000_000n).toString(),
    spendB: (400_000n).toString(),
    spendC: (2_000_000n).toString(),
  },
  // Identical to tests/lifecycle.ts. Seed = floor(100e6 · ln2) = 69_314_718.
  custom: {
    b: (100n * UNIT).toString(),
    creatorFunding: (500n * UNIT).toString(),
    traderFunding: (1_000n * UNIT).toString(),
    spendA: (10n * UNIT).toString(),
    spendB: (4n * UNIT).toString(),
    spendC: (20n * UNIT).toString(),
  },
};

function totalRequired(s: Scale): bigint {
  return BigInt(s.creatorFunding) + 3n * BigInt(s.traderFunding);
}

export interface FundingManifest {
  cluster: string;
  rpc: string;
  programId: string;
  treasury: string;
  /** Which of the ticket's three paths actually produced the collateral. */
  collateralPath: CollateralPath;
  /** True only for `circle-*`. Guard every "real USDC" claim on this. */
  isRealCircleUsdc: boolean;
  mint: string;
  decimals: number;
  /** Market size for this run; see `SCALES`. The test reads `b` and the spends from here. */
  scale: Scale;
  /** Human-readable note reproduced verbatim into docs/DEVNET.md. */
  note: string;
  wallets: Record<string, { pubkey: string; keypairFile: string; tokenAccount: string }>;
  fundedAt: string;
  signatures: string[];
}

// ---------------------------------------------------------------------------
// Devnet plumbing: retries
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry the transient half of devnet.
 *
 * Devnet fails in ways the local validator never does: a blockhash that expired
 * while the transaction was in flight, a 429 from the public RPC, a node that
 * has not caught up to the slot the last confirmation returned. All of those are
 * safe to retry. A program error (`custom program error`, an Anchor
 * `AnchorError`) is not — retrying it just repeats the same failure more slowly
 * — so those are rethrown immediately.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 6
): Promise<T> {
  let lastErr: any;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message ?? err);
      const logs: string[] = err?.logs ?? [];
      const isProgramError =
        /custom program error|AnchorError|Error Number:/.test(msg) ||
        logs.some((l) => /custom program error|AnchorError/.test(l));
      if (isProgramError) throw err;

      const isTransient =
        /blockhash not found|block height exceeded|Blockhash not found|expired|429|Too many requests|Too Many Requests|timed out|TimeoutError|socket hang up|ECONNRESET|ETIMEDOUT|fetch failed|503|502|Node is behind|has not been confirmed/i.test(
          msg
        );
      if (!isTransient && i >= 2) throw err;
      if (i === attempts) break;
      const backoff = Math.min(8000, 500 * 2 ** (i - 1));
      // eslint-disable-next-line no-console
      console.warn(`  [retry ${i}/${attempts}] ${label}: ${msg.split("\n")[0]} — waiting ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Keypair persistence
// ---------------------------------------------------------------------------

export function readKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

function loadOrCreateKeypair(file: string): Keypair {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) return readKeypair(file);
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

export function treasuryKeypair(): Keypair {
  const file =
    process.env.ANCHOR_WALLET ??
    process.env.GB_WALLET ??
    path.join(os.homedir(), ".config", "solana", "id.json");
  return readKeypair(file);
}

// ---------------------------------------------------------------------------
// (a) Circle's faucet
// ---------------------------------------------------------------------------

/**
 * Ask Circle's faucet for devnet USDC. Expected to fail; see the module header.
 * Returns true only if it actually dripped.
 */
export async function tryCircleFaucet(address: PublicKey): Promise<boolean> {
  // (a2) the documented REST API, if an API key is configured.
  const apiKey = process.env.CIRCLE_API_KEY;
  if (apiKey) {
    try {
      const res = await fetch("https://api.circle.com/v1/faucet/drips", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          address: address.toBase58(),
          blockchain: "SOL-DEVNET",
          native: false,
          usdc: true,
          eurc: false,
        }),
      });
      const body = await res.text();
      // eslint-disable-next-line no-console
      console.log(`  circle REST faucet -> HTTP ${res.status}: ${body.slice(0, 300)}`);
      if (res.ok) return true;
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.log(`  circle REST faucet -> ${err?.message ?? err}`);
    }
  } else {
    // eslint-disable-next-line no-console
    console.log("  circle REST faucet -> skipped (no CIRCLE_API_KEY; it 401s without one)");
  }

  // (a1) the public web faucet's own GraphQL mutation.
  try {
    const res = await fetch("https://faucet.circle.com/api/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://faucet.circle.com",
        Referer: "https://faucet.circle.com/",
      },
      body: JSON.stringify({
        query:
          "mutation RequestToken($input: RequestTokenInput!) { requestToken(input: $input) { __typename } }",
        variables: {
          input: {
            destinationAddress: address.toBase58(),
            blockchain: "SOL",
            token: "USDC",
          },
        },
      }),
    });
    const body: any = await res.json();
    const err = body?.errors?.[0];
    if (err) {
      // eslint-disable-next-line no-console
      console.log(
        `  circle web faucet -> ${err.extensions?.code ?? "ERROR"}: ${err.message}`
      );
      return false;
    }
    // eslint-disable-next-line no-console
    console.log(`  circle web faucet -> ${JSON.stringify(body).slice(0, 300)}`);
    return true;
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.log(`  circle web faucet -> ${err?.message ?? err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// SOL
// ---------------------------------------------------------------------------

async function transferSol(
  connection: Connection,
  from: Keypair,
  to: PublicKey,
  sol: number
): Promise<string> {
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }))
    .add(
      SystemProgram.transfer({
        fromPubkey: from.publicKey,
        toPubkey: to,
        lamports: Math.round(sol * LAMPORTS_PER_SOL),
      })
    );
  return withRetry(`transfer ${sol} SOL to ${to.toBase58()}`, () =>
    sendAndConfirmTransaction(connection, tx, [from], {
      commitment: COMMITMENT,
      preflightCommitment: COMMITMENT,
    })
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function fund(): Promise<FundingManifest> {
  const connection = new Connection(DEVNET_RPC, COMMITMENT);
  const treasury = treasuryKeypair();
  const signatures: string[] = [];

  console.log("=".repeat(70));
  console.log("GreekBet devnet funding");
  console.log(`  rpc      : ${DEVNET_RPC}`);
  console.log(`  treasury : ${treasury.publicKey.toBase58()}`);
  console.log("=".repeat(70));

  const treasurySol =
    (await withRetry("treasury balance", () =>
      connection.getBalance(treasury.publicKey, COMMITMENT)
    )) / LAMPORTS_PER_SOL;
  console.log(`treasury SOL: ${treasurySol}`);
  if (treasurySol < 0.5) {
    throw new Error(
      `treasury holds ${treasurySol} SOL, not enough to fund test wallets. ` +
        `The devnet airdrop is rate-limited and will not help — top it up by hand ` +
        `at https://faucet.solana.com (${treasury.publicKey.toBase58()}).`
    );
  }

  // --- choose the collateral mint ------------------------------------------

  const forced = process.env.GB_COLLATERAL;
  let collateralPath: CollateralPath;
  let scale: Scale;
  let mint: PublicKey;
  let mintAuthority: Keypair | null = null;

  console.log("\n## (a) Circle devnet faucet");
  const dripped = await tryCircleFaucet(treasury.publicKey);
  if (dripped) await sleep(8000);

  console.log("\n## (b) Circle USDC already held by the treasury");
  const circleAta = getAssociatedTokenAddressSync(
    CIRCLE_USDC_DEVNET,
    treasury.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );
  let circleBalance = 0n;
  try {
    const acc = await getAccount(connection, circleAta, COMMITMENT, TOKEN_PROGRAM_ID);
    circleBalance = acc.amount;
  } catch {
    circleBalance = 0n;
  }
  const needed = totalRequired(SCALES.circle);
  console.log(`  treasury USDC ATA : ${circleAta.toBase58()}`);
  console.log(
    `  balance           : ${circleBalance} base units ` +
      `(${Number(circleBalance) / 1e6} USDC; the scaled-down Circle fixture needs ` +
      `${Number(needed) / 1e6})`
  );

  if (forced === "circle" && circleBalance < needed) {
    throw new Error(
      `GB_COLLATERAL=circle was forced but the treasury holds ${
        Number(circleBalance) / 1e6
      } USDC and the fixture needs ${Number(needed) / 1e6}. Circle's faucet gives ` +
        `10 USDC per drip: open https://faucet.circle.com, choose Solana Devnet, paste ` +
        `${treasury.publicKey.toBase58()}, drip twice, then re-run.`
    );
  }
  if (forced !== "circle" && circleBalance > 0n && circleBalance < needed) {
    console.log("");
    console.log("  !! The treasury holds some Circle USDC but not enough for the fixture.");
    console.log(
      `  !! Drip ${Math.ceil((Number(needed - circleBalance) / 1e6) / 10)} more time(s) at ` +
        "https://faucet.circle.com to run on real USDC."
    );
    console.log("  !! Falling back to the custom mint for this run.");
    console.log("");
  }

  if (forced !== "custom" && circleBalance >= needed) {
    collateralPath = "circle-treasury-transfer";
    scale = SCALES.circle;
    mint = CIRCLE_USDC_DEVNET;
    const info = await getMint(connection, mint, COMMITMENT, TOKEN_PROGRAM_ID);
    if (info.decimals !== DECIMALS) {
      throw new Error(`Circle devnet USDC has ${info.decimals} decimals, expected ${DECIMALS}`);
    }
    console.log("  -> using REAL Circle devnet USDC, distributed from the treasury.");
  } else {
    console.log("\n## (c) custom 6-decimal mint (plan §3 fallback)");
    collateralPath = "custom-mint";
    scale = SCALES.custom;
    const mintKp = loadOrCreateKeypair(CUSTOM_MINT_FILE);
    mintAuthority = treasury;
    let exists = false;
    try {
      await getMint(connection, mintKp.publicKey, COMMITMENT, TOKEN_PROGRAM_ID);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) {
      await withRetry("createMint", () =>
        createMint(
          connection,
          treasury,
          treasury.publicKey,
          null,
          DECIMALS,
          mintKp,
          { commitment: COMMITMENT },
          TOKEN_PROGRAM_ID
        )
      );
      console.log(`  created mint ${mintKp.publicKey.toBase58()}`);
    } else {
      console.log(`  reusing mint ${mintKp.publicKey.toBase58()}`);
    }
    mint = mintKp.publicKey;
    console.log("  -> NOT real USDC. The run exercises the same SPL paths, but the");
    console.log("     'real devnet USDC' exit criterion is only partially met.");
  }

  // --- wallets --------------------------------------------------------------

  console.log("\n## test wallets");
  const wallets: FundingManifest["wallets"] = {};
  for (const role of ROLES) {
    const file = path.join(WALLETS_DIR, `${role}.json`);
    const kp = loadOrCreateKeypair(file);
    const lamports = await withRetry(`balance ${role}`, () =>
      connection.getBalance(kp.publicKey, COMMITMENT)
    );
    const sol = lamports / LAMPORTS_PER_SOL;
    if (sol < SOL_PER_WALLET / 2) {
      const sig = await transferSol(connection, treasury, kp.publicKey, SOL_PER_WALLET);
      signatures.push(sig);
      console.log(`  ${role.padEnd(8)} ${kp.publicKey.toBase58()}  +${SOL_PER_WALLET} SOL  ${sig}`);
    } else {
      console.log(`  ${role.padEnd(8)} ${kp.publicKey.toBase58()}  has ${sol} SOL (skipped)`);
    }

    const ata = await withRetry(`ata ${role}`, () =>
      getOrCreateAssociatedTokenAccount(
        connection,
        treasury,
        mint,
        kp.publicKey,
        false,
        COMMITMENT,
        { commitment: COMMITMENT },
        TOKEN_PROGRAM_ID
      )
    );

    const want =
      role === "creator" ? BigInt(scale.creatorFunding) : BigInt(scale.traderFunding);
    if (ata.amount < want) {
      const delta = want - ata.amount;
      let sig: string;
      if (collateralPath === "custom-mint") {
        sig = await withRetry(`mintTo ${role}`, () =>
          mintTo(
            connection,
            treasury,
            mint,
            ata.address,
            mintAuthority!,
            delta,
            [],
            { commitment: COMMITMENT },
            TOKEN_PROGRAM_ID
          )
        );
      } else {
        sig = await withRetry(`transfer USDC to ${role}`, () =>
          transferChecked(
            connection,
            treasury,
            circleAta,
            mint,
            ata.address,
            treasury,
            delta,
            DECIMALS,
            [],
            { commitment: COMMITMENT },
            TOKEN_PROGRAM_ID
          )
        );
      }
      signatures.push(sig);
      console.log(`           collateral ${ata.address.toBase58()} +${delta}  ${sig}`);
    } else {
      console.log(`           collateral ${ata.address.toBase58()} has ${ata.amount} (skipped)`);
    }

    wallets[role] = {
      pubkey: kp.publicKey.toBase58(),
      keypairFile: file,
      tokenAccount: ata.address.toBase58(),
    };
  }

  const note =
    collateralPath === "custom-mint"
      ? "FALLBACK PATH (c): a custom 6-decimal SPL mint created by this script. " +
        "NOT Circle devnet USDC. Circle's faucet is reCAPTCHA-gated and cannot be " +
        "scripted; see the header of scripts/devnet/fund.ts. Plan §3 permits this " +
        "fallback, but the plan §4.3 criterion 'real devnet USDC transfers' is only " +
        "partially satisfied by a run on this mint."
      : "PATH (b): real Circle devnet USDC (4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU), " +
        "distributed from the treasury wallet. The treasury was topped up manually " +
        "through https://faucet.circle.com because the faucet is reCAPTCHA-gated.";

  const manifest: FundingManifest = {
    cluster: "devnet",
    rpc: DEVNET_RPC,
    programId: "GRUTmtYopUczvS5m62YAvctbS9TTrbznnnj5GmFHumSZ",
    treasury: treasury.publicKey.toBase58(),
    collateralPath,
    isRealCircleUsdc: collateralPath !== "custom-mint",
    mint: mint.toBase58(),
    decimals: DECIMALS,
    scale,
    note,
    wallets,
    fundedAt: new Date().toISOString(),
    signatures,
  };

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(FUNDING_FILE, JSON.stringify(manifest, null, 2));

  console.log("\n" + "=".repeat(70));
  console.log(`collateral path : ${collateralPath}`);
  console.log(`real USDC?      : ${manifest.isRealCircleUsdc ? "YES" : "NO"}`);
  console.log(`mint            : ${manifest.mint}`);
  console.log(`market b        : ${Number(scale.b) / 1e6} units`);
  console.log(`manifest        : ${FUNDING_FILE}`);
  console.log("=".repeat(70));
  return manifest;
}

export function readFundingManifest(): FundingManifest {
  if (!fs.existsSync(FUNDING_FILE)) {
    throw new Error(
      `no funding manifest at ${FUNDING_FILE}. Run:\n` +
        `  NODE_OPTIONS=--no-experimental-strip-types \\\n` +
        `    node_modules/.bin/ts-node -P tsconfig.json scripts/devnet/fund.ts`
    );
  }
  return JSON.parse(fs.readFileSync(FUNDING_FILE, "utf8")) as FundingManifest;
}

if (require.main === module) {
  fund().then(
    () => process.exit(0),
    (err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    }
  );
}
