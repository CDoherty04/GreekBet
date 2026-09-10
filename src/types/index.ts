/**
 * Shared domain types for Groupbet.
 *
 * Single source of truth for what flows between the API routes
 * (`src/app/api/**`) and the client screens (`src/app/**`). Small and
 * JSON-serializable so the same types work on both sides.
 *
 * ## Off-chain vs on-chain
 *
 * Markets are **LMSR prediction markets on Solana**. The program owns the money
 * and the pricing: liquidity `b`, share supplies, positions, prices, and the
 * resolved outcome all live on chain, and the app learns about them from the
 * indexer's event stream (`src/lib/chain/projection.ts`).
 *
 * What stays off chain is what the program has no concept of: groups,
 * membership, the question *text* (the program stores only its SHA-256), and
 * the resolution photo. {@link Market} is therefore metadata joined to a
 * `ChainMarket` at read time — never a second copy of the on-chain state.
 *
 * All base-unit amounts are **decimal strings**. Shares reach 1e15 and a JSON
 * number would silently lose precision at the top of the range.
 */

export type ID = string;

/** Which side of a yes/no market. Maps to the program's `Outcome` enum. */
export type Side = "yes" | "no";

/** Mirrors the program's `MarketStatus`. */
export type MarketStatus = "open" | "closed" | "resolved";

/**
 * A person.
 *
 * `id` is the Privy user DID (`did:privy:…`). `walletAddress` is their Privy
 * embedded Solana wallet — keys never touch this server.
 */
export interface User {
  id: ID;
  name: string;
  phone: string;
  avatarUrl: string;
  /** Base58 Solana address (Privy embedded wallet). */
  walletAddress: string;
  /** Telegram chat id after linking the bot (for event DMs). */
  telegramChatId?: string;
  telegramUsername?: string;
  worldId: string;
  verified: boolean;
  createdAt: number;
}

/** A private group of friends that markets live inside. Purely off-chain. */
export interface Group {
  id: ID;
  name: string;
  code: string;
  ownerId: ID;
  memberIds: ID[];
  createdAt: number;
}

/**
 * Off-chain metadata for an on-chain market.
 *
 * `address` is the market PDA and the join key to everything on chain. The
 * question text lives here because the program stores only `sha256(question)` —
 * losing this text means the market can still trade but can never again be
 * displayed or its PDA re-derived.
 */
export interface Market {
  /** Market PDA, base58. The canonical id everywhere. */
  address: string;
  groupId: ID;
  title: string;
  description?: string;
  /** Internal user id of the creator. */
  createdBy: ID;
  createdAt: number;
  /** Photo the AI resolver read, if resolved that way. */
  resolutionImageUrl?: string;
  resolutionNote?: string;
  /** Signature of the `create_market` transaction, for explorer links. */
  createSignature?: string;

  /**
   * The AI's suggested outcome — **advisory only**; the owner confirms.
   *
   * That separation matters more now than it did off chain: confirming writes
   * the outcome with the resolver authority, and the program makes that write
   * one-way. A confident AI is not reason enough to do it unilaterally.
   */
  aiPrediction?: Side;
  /** 0..1 confidence from the AI resolver. */
  aiConfidence?: number;

  /** Owner-pinned: sorts to the top of the group feed. */
  pinned?: boolean;
  /**
   * Owner-archived: hidden from the main feed.
   *
   * Off-chain only. Archiving hides a market from this app; it cannot touch the
   * on-chain market, which keeps trading or stays redeemable regardless. The
   * same is true of deletion — it drops the metadata while the PDA and its
   * vault live on.
   */
  archived?: boolean;
}

/* ------------------------------------------------------------------ */
/* View models — assembled from metadata + the indexer projection      */
/* ------------------------------------------------------------------ */

/**
 * LMSR pricing for a market.
 *
 * Replaces the old parimutuel pool. The distinction is not cosmetic: under a
 * parimutuel the odds are just the ratio of money already staked, whereas here
 * the price is set by a market maker along a bonding curve, the creator
 * subsidises it with `b·ln2`, and a trader can **sell before resolution** at
 * the prevailing price rather than being locked in.
 */
export interface MarketPricing {
  /** Implied probability of YES, 0..1, from the on-chain marginal price. */
  yesProb: number;
  noProb: number;
  /** Outstanding shares, base units. */
  qYes: string;
  qNo: string;
  /** Liquidity parameter, base units. */
  b: string;
  /** Creator's subsidy, `b·ln2`, base units. */
  seedAmount: string;
  /** Collateral held by the vault, base units. */
  volume: string;
}

/** One on-chain trade. */
export interface Trade {
  signature: string;
  slot: number;
  blockTime: number | null;
  /** Wallet address of the trader. */
  user: string;
  /** Display name, joined from the user store where known. */
  userName?: string;
  userAvatarUrl?: string;
  side: Side;
  isBuy: boolean;
  /** Base units. */
  collateral: string;
  shares: string;
}

/** A holder's position in one market. */
export interface Position {
  yesShares: string;
  noShares: string;
  payout?: string;
  redeemed: boolean;
}

/** Everything a screen needs to render a market, in one payload. */
export interface MarketView extends Market {
  status: MarketStatus;
  /** Unix ms, converted from the program's seconds. */
  expiresAt: number;
  outcome?: Side;
  pricing: MarketPricing;
  trades: Trade[];
  /** The requesting user's position, when they have one. */
  myPosition?: Position;
  /** True once the market exists on chain and the indexer has seen it. */
  indexed: boolean;
  /** Who may pin, archive, delete, and confirm resolution. */
  groupOwnerId: ID;
}
