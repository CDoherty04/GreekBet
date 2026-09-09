/**
 * Shared domain types for Groupbet.
 *
 * These are the single source of truth for the shape of data that flows
 * between the API routes (`src/app/api/**`) and the client screens
 * (`src/app/**`). Keep them small and serializable (JSON-friendly) so the
 * same types work on both the server and the client.
 */

export type ID = string;

/** Which side of a yes/no market a bet is on. */
export type Side = "yes" | "no";

/** Lifecycle of a prediction market. */
export type MarketStatus = "open" | "resolving" | "resolved";

/**
 * A person. Created from just a selfie + phone number.
 * - `verified` comes from World Selfie Check (proof of personhood).
 * - `walletAddress` is provisioned automatically by Privy.
 * - `balance` is the user's internal play-token balance.
 */
export interface User {
  id: ID;
  name: string;
  phone: string;
  /** Data URL / remote URL of the signup selfie. Also used for face-match. */
  avatarUrl: string;
  /** Auto-created embedded wallet address (Privy). */
  walletAddress: string;
  /** Proof-of-personhood id from World Selfie Check. */
  worldId: string;
  /** True once World Selfie Check has verified a real, unique human. */
  verified: boolean;
  /** Internal play-token balance. */
  balance: number;
  createdAt: number;
}

/** A private group of friends (like a Venmo group) that markets live inside. */
export interface Group {
  id: ID;
  name: string;
  /** 6-char alphanumeric invite code. */
  code: string;
  ownerId: ID;
  memberIds: ID[];
  createdAt: number;
}

/** A single yes/no prediction market inside a group. */
export interface Market {
  id: ID;
  groupId: ID;
  title: string;
  description?: string;
  createdBy: ID;
  createdAt: number;
  /** Betting closes at this time. */
  expiresAt: number;
  status: MarketStatus;
  /** Set once resolved. */
  outcome?: Side;
  /** Uploaded photo used for resolution. */
  resolutionImageUrl?: string;
  /** Sanitized, AI-generated description of the resolution photo. */
  resolutionNote?: string;
  /** AI's suggested outcome — owner (later: 3/4 majority) confirms. */
  aiPrediction?: Side;
  /** 0..1 confidence from the AI resolver. */
  aiConfidence?: number;
}

/** A stake placed by a user on one side of a market. */
export interface Bet {
  id: ID;
  marketId: ID;
  userId: ID;
  side: Side;
  amount: number;
  createdAt: number;
  /** Tokens returned once the market resolves (0 if the bet lost). */
  payout?: number;
  /** Display name, filled in on MarketView (not stored). */
  userName?: string;
  userAvatarUrl?: string;
}

/* ------------------------------------------------------------------ */
/* Derived / view-model types (computed, never stored)                 */
/* ------------------------------------------------------------------ */

/** Pool totals + implied odds for a market, derived from its bets. */
export interface MarketPool {
  yes: number;
  no: number;
  total: number;
  /** Implied probability of "yes" (0..1). */
  yesProb: number;
  /** Implied probability of "no" (0..1). */
  noProb: number;
}

/** A market plus everything a screen needs to render it in one payload. */
export interface MarketView extends Market {
  pool: MarketPool;
  bets: Bet[];
  groupOwnerId: ID;
}
