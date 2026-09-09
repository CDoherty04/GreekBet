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

  // ---- Markets ---------------------------------------------------------
  listMarkets: (groupId: string) =>
    request<{ markets: MarketView[] }>(`/api/groups/${groupId}/markets`),

  createMarket: (
    groupId: string,
    input: { title: string; description?: string; expiresAt: number },
  ) =>
    request<{ market: MarketView }>(`/api/groups/${groupId}/markets`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  getMarket: (marketId: string) =>
    request<{ market: MarketView }>(`/api/markets/${marketId}`),

  placeBet: (marketId: string, input: { side: Side; amount: number }) =>
    request<{ market: MarketView; balance: number }>(
      `/api/markets/${marketId}/bet`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  resolveMarket: (marketId: string, input: { imageDataUrl: string }) =>
    request<{
      market: MarketView;
      outcome: Side;
      description: string;
      faceMatch: { match: boolean; confidence: number };
    }>(`/api/markets/${marketId}/resolve`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
