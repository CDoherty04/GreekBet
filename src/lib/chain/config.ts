/**
 * On-chain configuration.
 *
 * The market maker is the LMSR Anchor program in `contracts/`, deployed to
 * devnet. Everything here is devnet-only — see `contracts/docs/DEVNET.md`.
 */

import { PublicKey } from "@solana/web3.js";

/** Deployed program id (devnet). Overridable for a local validator. */
export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_GREEKBET_PROGRAM_ID ??
    "GRUTmtYopUczvS5m62YAvctbS9TTrbznnnj5GmFHumSZ",
);

export const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";

/**
 * Collateral mint. **Per market on chain**, so this is only the default used
 * when creating one — every read validates against the market's stored mint.
 *
 * Defaults to Circle's devnet USDC. A custom 6-decimal mint works too; the
 * program only requires `decimals == 6`.
 */
export const COLLATERAL_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_COLLATERAL_MINT ??
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

/** Shares and collateral share this unit, which is what makes redemption 1:1. */
export const DECIMALS = 6;
export const UNIT = 1_000_000;

/** LMSR liquidity bounds enforced by the program (`docs/DESIGN_DECISIONS.md` D4). */
export const B_MIN = 10_000_000; // 10 USDC
export const B_MAX = 1_000_000_000_000; // 1,000,000 USDC

/**
 * Default liquidity for a new market: 10 USDC, the program's minimum.
 *
 * `b` is what the creator subsidises the market with — they deposit
 * `b·ln2 ≈ 6.93 USDC` up front and can lose it. Devnet USDC is scarce (the
 * faucet is reCAPTCHA-gated), so the floor is the sensible default here.
 */
export const DEFAULT_B = B_MIN;

/** Base units → a human string, e.g. 1_500_000 → "1.50". */
export function formatUnits(baseUnits: string | number | bigint, dp = 2): string {
  const n = BigInt(baseUnits);
  const whole = n / BigInt(UNIT);
  const frac = n % BigInt(UNIT);
  const fracStr = frac.toString().padStart(DECIMALS, "0").slice(0, dp);
  return dp > 0 ? `${whole}.${fracStr}` : whole.toString();
}

/** "1.5" → 1_500_000n. Throws on more precision than the mint can hold. */
export function parseUnits(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error("Enter a number");
  }
  const [whole = "0", frac = ""] = trimmed.split(".");
  if (frac.length > DECIMALS) {
    throw new Error(`At most ${DECIMALS} decimal places`);
  }
  return BigInt(whole || "0") * BigInt(UNIT) + BigInt(frac.padEnd(DECIMALS, "0") || "0");
}

/** LMSR price (a fraction of 1e6) → probability in 0..1. */
export function priceToProb(price: string | number): number {
  return Number(price) / UNIT;
}
