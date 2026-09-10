/**
 * In-memory data store for the **off-chain** half of the app.
 *
 * Groups, membership, user profiles, and market metadata (the question text,
 * which group a market belongs to, the resolution photo). Everything about
 * money — prices, positions, trades, settlement — lives on chain and is read
 * through `src/lib/chain/projection.ts`, never from here.
 *
 * Persisted to `.data/app-store.json` so a Privy session still maps to an app
 * profile after `next` restarts (otherwise authenticated users get stuck
 * re-onboarding).
 *
 * Also attached to `globalThis` so it survives hot-reloads in development.
 */

import "server-only";

import * as fs from "fs";
import * as path from "path";
import type { Group, ID, Market, User } from "@/types";
import { seedDemoData } from "@/lib/db/seed";
import { normalizePhone } from "@/lib/phone";

interface Store {
  users: Map<ID, User>;
  groups: Map<ID, Group>;
  /** Keyed by **market PDA**, not an internal id — the PDA is the join key. */
  markets: Map<string, Market>;
  seeded: boolean;
}

interface PersistedStore {
  users: User[];
  groups: Group[];
  markets: Market[];
}

const STORE_FILE = path.join(process.cwd(), ".data", "app-store.json");

const globalForStore = globalThis as unknown as { __groupbetStore?: Store };

function persistSoon(store: Store): void {
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    const payload: PersistedStore = {
      users: [...store.users.values()],
      groups: [...store.groups.values()],
      markets: [...store.markets.values()],
    };
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
    fs.renameSync(tmp, STORE_FILE);
  } catch (err) {
    console.error("app-store persist failed", err);
  }
}

function loadPersisted(): Store | null {
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    const data = JSON.parse(raw) as PersistedStore;
    if (!Array.isArray(data.users)) return null;
    return {
      users: new Map(data.users.map((u) => [u.id, u])),
      groups: new Map((data.groups ?? []).map((g) => [g.id, g])),
      markets: new Map((data.markets ?? []).map((m) => [m.address, m])),
      seeded: true,
    };
  } catch {
    return null;
  }
}

function createStore(): Store {
  const persisted = loadPersisted();
  if (persisted) return persisted;

  const store: Store = {
    users: new Map(),
    groups: new Map(),
    markets: new Map(),
    seeded: false,
  };
  seedDemoData(store);
  store.seeded = true;
  persistSoon(store);
  return store;
}

const store: Store = (globalForStore.__groupbetStore ??= createStore());

export const db = {
  // ---- Users -----------------------------------------------------------
  getUser(id: ID): User | undefined {
    return store.users.get(id);
  },
  getUserByPhone(phone: string): User | undefined {
    const needle = normalizePhone(phone);
    return [...store.users.values()].find(
      (u) => normalizePhone(u.phone) === needle,
    );
  },
  /** Reverse lookup, so on-chain trades can be shown with a name and face. */
  getUserByWallet(walletAddress: string): User | undefined {
    return [...store.users.values()].find(
      (u) => u.walletAddress === walletAddress,
    );
  },
  createUser(user: User): User {
    store.users.set(user.id, user);
    persistSoon(store);
    return user;
  },
  updateUser(id: ID, patch: Partial<User>): User | undefined {
    const user = store.users.get(id);
    if (!user) return undefined;
    const next = { ...user, ...patch };
    store.users.set(id, next);
    persistSoon(store);
    return next;
  },

  // ---- Groups ----------------------------------------------------------
  getGroup(id: ID): Group | undefined {
    return store.groups.get(id);
  },
  getGroupByCode(code: string): Group | undefined {
    const upper = code.toUpperCase();
    return [...store.groups.values()].find((g) => g.code === upper);
  },
  listGroupsForUser(userId: ID): Group[] {
    return [...store.groups.values()]
      .filter((g) => g.memberIds.includes(userId))
      .sort((a, b) => b.createdAt - a.createdAt);
  },
  createGroup(group: Group): Group {
    store.groups.set(group.id, group);
    persistSoon(store);
    return group;
  },
  addMember(groupId: ID, userId: ID): Group | undefined {
    const group = store.groups.get(groupId);
    if (!group) return undefined;
    if (!group.memberIds.includes(userId)) group.memberIds.push(userId);
    persistSoon(store);
    return group;
  },
  removeMember(groupId: ID, userId: ID): Group | undefined {
    const group = store.groups.get(groupId);
    if (!group) return undefined;
    group.memberIds = group.memberIds.filter((id) => id !== userId);
    persistSoon(store);
    return group;
  },

  // ---- Market metadata -------------------------------------------------
  getMarket(address: string): Market | undefined {
    return store.markets.get(address);
  },
  listMarketsForGroup(groupId: ID): Market[] {
    return [...store.markets.values()]
      .filter((m) => m.groupId === groupId)
      .sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        return b.createdAt - a.createdAt;
      });
  },
  createMarket(market: Market): Market {
    store.markets.set(market.address, market);
    persistSoon(store);
    return market;
  },
  updateMarket(address: string, patch: Partial<Market>): Market | undefined {
    const market = store.markets.get(address);
    if (!market) return undefined;
    const next = { ...market, ...patch };
    store.markets.set(address, next);
    persistSoon(store);
    return next;
  },
  /**
   * Forget a market's metadata.
   *
   * **Off-chain only, and worth being clear about.** The on-chain market, its
   * vault and everyone's positions are untouched — the program has no delete
   * and collateral cannot be clawed back. This removes the question text and
   * the group link, so the app stops showing it; holders can still redeem via
   * the PDA. Deleting one with live positions strands people in the UI, which
   * is why the route restricts it.
   */
  deleteMarket(address: string): boolean {
    const ok = store.markets.delete(address);
    if (ok) persistSoon(store);
    return ok;
  },
};

export type { Store };
