/**
 * Client-side API helpers.
 *
 * Thin wrappers around `fetch`. Auth is a Privy access token in
 * `Authorization: Bearer …` (set via {@link setAccessTokenProvider}).
 */

import type { Group, MarketView, SettleResult, Side, User } from "@/types";

type TokenProvider = () => Promise<string | null>;

/** A non-2xx response. `message` is the server's `error` string when it sent one. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

let accessTokenProvider: TokenProvider | null = null;

/** Wired from SessionProvider once Privy is ready. */
export function setAccessTokenProvider(provider: TokenProvider | null) {
  accessTokenProvider = provider;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  const token = accessTokenProvider ? await accessTokenProvider() : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getSession: () => request<{ user: User | null }>("/api/session"),

  /**
   * Complete app onboarding after Privy SMS login (new users), or refresh the
   * stored wallet address for returning users.
   */
  completeProfile: (input: {
    name: string;
    phone: string;
    selfieDataUrl: string;
    walletAddress: string;
  }) =>
    request<{ user: User }>("/api/session", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  syncWallet: (walletAddress: string) =>
    request<{ user: User }>("/api/session", {
      method: "POST",
      body: JSON.stringify({ walletAddress }),
    }),

  signOut: () => request<{ ok: true }>("/api/session", { method: "DELETE" }),

  listGroups: () => request<{ groups: Group[] }>("/api/groups"),

  createGroup: (name: string) =>
    request<{ group: Group }>("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  joinGroup: (code: string) =>
    request<{ group: Group }>("/api/groups/join", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),

  getGroup: (groupId: string) =>
    request<{
      group: Group;
      members: User[];
      markets?: MarketView[];
      isMember: boolean;
      memberCount: number;
    }>(`/api/groups/${groupId}`),

  joinGroupById: (groupId: string) =>
    request<{ group: Group }>(`/api/groups/${groupId}/join`, {
      method: "POST",
    }),

  removeMember: (groupId: string, userId: string) =>
    request<{ ok: true }>(`/api/groups/${groupId}/members/${userId}`, {
      method: "DELETE",
    }),

  listMarkets: (groupId: string) =>
    request<{ markets: MarketView[] }>(`/api/groups/${groupId}/markets`),

  /**
   * Build an unsigned create-market transaction. The client signs and sends
   * it with Privy, then calls {@link confirmMarket}.
   */
  prepareCreateMarket: (
    groupId: string,
    input: {
      title: string;
      description?: string;
      expiresAt: number;
      b?: number;
    },
  ) =>
    request<{
      transaction: string;
      marketAddress: string;
      vault: string;
      seedAmount: string;
      title: string;
      description?: string;
      expiresAt: number;
    }>(`/api/groups/${groupId}/markets`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  confirmMarket: (
    groupId: string,
    input: {
      marketAddress: string;
      signature: string;
      title: string;
      description?: string;
      seedAmount: string;
    },
  ) =>
    request<{ market: MarketView; signature: string; seedAmount: string }>(
      `/api/groups/${groupId}/markets/confirm`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  getMarket: (marketId: string) =>
    request<{ market: MarketView }>(`/api/markets/${marketId}`),

  updateMarket: (
    marketId: string,
    input: { pinned?: boolean; archived?: boolean },
  ) =>
    request<{ market: MarketView }>(`/api/markets/${marketId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  deleteMarket: (marketId: string) =>
    request<{ ok: true }>(`/api/markets/${marketId}`, { method: "DELETE" }),

  quote: (
    marketId: string,
    input: { side: Side; action: "buy" | "sell"; amount: string },
  ) =>
    request<{ received: string; avgPrice: string }>(
      `/api/markets/${marketId}/quote`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  prepareTrade: (
    marketId: string,
    input: {
      side: Side;
      action: "buy" | "sell";
      amount: string;
      slippage?: number;
    },
  ) =>
    request<{ transaction: string; received: string }>(
      `/api/markets/${marketId}/trade`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  prepareRedeem: (marketId: string) =>
    request<{ transaction: string }>(`/api/markets/${marketId}/redeem`, {
      method: "POST",
    }),

  /**
   * Submit a resolution photo: describe → validate → policy. `settle` is set
   * when the server tried to settle straight away (close time already passed).
   * 409 once a record exists unless the caller is the owner.
   */
  resolveMarket: (marketId: string, input: { imageDataUrl: string }) =>
    request<{ market: MarketView; settle: SettleResult | null }>(
      `/api/markets/${marketId}/resolve`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  /** Owner: drop the resolution record and photo so a new one can be taken. */
  clearResolution: (marketId: string) =>
    request<{ market: MarketView }>(`/api/markets/${marketId}/resolve`, {
      method: "DELETE",
    }),

  /** Owner: pick the outcome. Settles now if close time passed, else `waiting`. */
  confirmResolution: (marketId: string, outcome: Side) =>
    request<{ market: MarketView; settle: SettleResult }>(
      `/api/markets/${marketId}/resolve/confirm`,
      { method: "POST", body: JSON.stringify({ outcome }) },
    ),

  /** Owner: settle a `pending`/`failed` record on chain. 409 before close. */
  settleMarket: (marketId: string) =>
    request<{ market: MarketView; settle: SettleResult }>(
      `/api/markets/${marketId}/settle`,
      { method: "POST" },
    ),

  getBalance: () =>
    request<{ sol: string; usdc: string; address: string }>("/api/wallet"),

  /** Devnet: send SOL + test collateral to the signed-in Privy wallet. */
  fundWallet: () =>
    request<{
      ok: boolean;
      skipped?: boolean;
      sol?: number;
      collateral?: number;
      mint?: string;
      address: string;
    }>("/api/wallet/fund", { method: "POST" }),

  /** Open a deep link so the user can Start the bot; then call syncTelegram. */
  linkTelegram: (username?: string) =>
    request<{
      linked: boolean;
      username?: string;
      botUsername: string | null;
      deepLink: string | null;
      code: string | null;
    }>("/api/telegram/link", {
      method: "POST",
      body: JSON.stringify({ username }),
    }),

  /** Poll bot /start messages and attach chat id to the signed-in user. */
  syncTelegram: () =>
    request<{
      matched: boolean;
      linked: number;
      telegramChatId: string | null;
      telegramUsername: string | null;
    }>("/api/telegram/sync", { method: "POST" }),
};
