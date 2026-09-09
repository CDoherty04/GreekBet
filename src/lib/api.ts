/**
 * Client-side API helpers.
 *
 * Thin wrappers around `fetch` so screens don't repeat URL strings and error
 * handling. Every call hits our own `/api/**` route handlers and sends
 * cookies (for the session) by default.
 */

import type { Group, MarketView, Side, User } from "@/types";

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // ---- Session / onboarding -------------------------------------------
  getSession: () => request<{ user: User | null }>("/api/session"),

  signUp: (input: { name: string; phone: string; selfieDataUrl: string }) =>
    request<{ user: User }>("/api/session", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  signOut: () => request<{ ok: true }>("/api/session", { method: "DELETE" }),

  sendVerification: (phone: string) =>
    request<{
      phone: string;
      channel: "telegram" | "stub";
      expiresIn: number;
      resendIn: number;
      devCode?: string;
    }>("/api/verify/send", {
      method: "POST",
      body: JSON.stringify({ phone }),
    }),

  checkVerification: (phone: string, code: string) =>
    request<{ ok: true; phone: string; user: User | null }>("/api/verify/check", {
      method: "POST",
      body: JSON.stringify({ phone, code }),
    }),

  sendTelegram: (text: string, phone: string) =>
    request<{ ok: true; phone: string; chatId: string }>("/api/telegram/send", {
      method: "POST",
      body: JSON.stringify({ text, phone }),
    }),

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

  syncTelegram: () =>
    request<{
      matched: boolean;
      linked: number;
      telegramChatId: string | null;
      telegramUsername: string | null;
    }>("/api/telegram/sync", { method: "POST" }),

  debugStatus: () =>
    request<{
      telegramBot: boolean;
      telegramGateway: boolean;
      linkedChatId: boolean;
    }>("/api/debug/status"),

  // ---- Groups ----------------------------------------------------------
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

  // ---- Markets ---------------------------------------------------------
  listMarkets: (groupId: string) =>
    request<{ markets: MarketView[] }>(`/api/groups/${groupId}/markets`),

  /**
   * Create a market on chain. Slow by web standards — it submits a Solana
   * transaction and waits for confirmation, so devnet latency (600–2,000 ms,
   * occasionally much worse) lands directly on this call.
   */
  createMarket: (
    groupId: string,
    input: {
      title: string;
      description?: string;
      expiresAt: number;
      /** LMSR liquidity in base units. Defaults to the program minimum. */
      b?: number;
    },
  ) =>
    request<{ market: MarketView; signature: string; seedAmount: string }>(
      `/api/groups/${groupId}/markets`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  /** `marketId` is the market PDA everywhere below. */
  getMarket: (marketId: string) =>
    request<{ market: MarketView }>(`/api/markets/${marketId}`),

  /** Owner-only: pin or archive. Off-chain display state, not chain state. */
  updateMarket: (
    marketId: string,
    input: { pinned?: boolean; archived?: boolean },
  ) =>
    request<{ market: MarketView }>(`/api/markets/${marketId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  /**
   * Owner-only: forget a market's metadata.
   *
   * Off-chain only — the PDA, its vault and everyone's positions survive, and
   * holders can still redeem. The route refuses while positions are open.
   */
  deleteMarket: (marketId: string) =>
    request<{ ok: true }>(`/api/markets/${marketId}`, { method: "DELETE" }),

  /**
   * What a trade would give, without doing it.
   *
   * Simulated against the real program, so the number matches what the trade
   * will actually produce rather than a JavaScript approximation of the LMSR.
   * `amount` is base units as a string: collateral for a buy, shares for a sell.
   */
  quote: (
    marketId: string,
    input: { side: Side; action: "buy" | "sell"; amount: string },
  ) =>
    request<{ received: string; avgPrice: string }>(
      `/api/markets/${marketId}/quote`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  /** Buy or sell outcome shares. Replaces the old parimutuel `placeBet`. */
  trade: (
    marketId: string,
    input: {
      side: Side;
      action: "buy" | "sell";
      amount: string;
      slippage?: number;
    },
  ) =>
    request<{ signature: string; received: string; market: MarketView }>(
      `/api/markets/${marketId}/trade`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  /** Claim a resolved position: winners 1:1, losers zero but still cleared. */
  redeem: (marketId: string) =>
    request<{ signature: string; market: MarketView }>(
      `/api/markets/${marketId}/redeem`,
      { method: "POST" },
    ),

  resolveMarket: (marketId: string, input: { imageDataUrl: string }) =>
    request<{
      market: MarketView;
      prediction: { outcome: Side; confidence: number; description: string };
      faceMatch: { match: boolean; confidence: number };
      signature: string;
    }>(`/api/markets/${marketId}/resolve`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /**
   * Owner casts the deciding vote, which settles the market **on chain**.
   *
   * The AI's reading is advisory; this is the irreversible step. The resolver
   * authority writes the outcome, and the program has no way to change it
   * afterwards.
   */
  confirmResolution: (marketId: string, outcome: Side) =>
    request<{ market: MarketView; outcome: Side; signature: string }>(
      `/api/markets/${marketId}/resolve/confirm`,
      { method: "POST", body: JSON.stringify({ outcome }) },
    ),

  /** On-chain wallet balances, for the header pill and trade validation. */
  getBalance: () =>
    request<{ sol: string; usdc: string; address: string }>("/api/wallet"),
};
