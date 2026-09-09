/**
 * In-memory data store (the "database" for the hackathon).
 *
 * Everything lives in Maps held in module state. This is intentionally the
 * simplest thing that works for a demo running on a single server process.
 *
 * LOOKING AHEAD: every read/write goes through the small `db` API below, so
 * swapping this for a real database (Postgres, Sanity, Convex, etc.) later
 * means reimplementing this one file — the API routes never touch the Maps
 * directly. A DB adapter can live in `src/lib/db/`.
 *
 * The store is attached to `globalThis` so it survives Next.js hot-reloads in
 * development (otherwise every code change would wipe the demo data).
 */

import type { Bet, Group, ID, Market, User } from "@/types";
import { seedDemoData } from "@/lib/db/seed";

interface Store {
  users: Map<ID, User>;
  groups: Map<ID, Group>;
  markets: Map<ID, Market>;
  bets: Map<ID, Bet>;
  seeded: boolean;
}

const globalForStore = globalThis as unknown as { __groupbetStore?: Store };

function createStore(): Store {
  const store: Store = {
    users: new Map(),
    groups: new Map(),
    markets: new Map(),
    bets: new Map(),
    seeded: false,
  };
  // Populate a little demo data so screens aren't empty on first load.
  seedDemoData(store);
  store.seeded = true;
  return store;
}

const store: Store = (globalForStore.__groupbetStore ??= createStore());

/**
 * Tiny data-access layer. Keep all persistence logic here so the rest of the
 * app depends on this stable surface rather than on the storage mechanism.
 */
export const db = {
  // ---- Users -----------------------------------------------------------
  getUser(id: ID): User | undefined {
    return store.users.get(id);
  },
  getUserByPhone(phone: string): User | undefined {
    return [...store.users.values()].find((u) => u.phone === phone);
  },
  createUser(user: User): User {
    store.users.set(user.id, user);
    return user;
  },
  updateUser(id: ID, patch: Partial<User>): User | undefined {
    const user = store.users.get(id);
    if (!user) return undefined;
    const next = { ...user, ...patch };
    store.users.set(id, next);
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
    return group;
  },
  addMember(groupId: ID, userId: ID): Group | undefined {
    const group = store.groups.get(groupId);
    if (!group) return undefined;
    if (!group.memberIds.includes(userId)) group.memberIds.push(userId);
    return group;
  },
  removeMember(groupId: ID, userId: ID): Group | undefined {
    const group = store.groups.get(groupId);
    if (!group) return undefined;
    group.memberIds = group.memberIds.filter((id) => id !== userId);
    return group;
  },

  // ---- Markets ---------------------------------------------------------
  getMarket(id: ID): Market | undefined {
    return store.markets.get(id);
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
    store.markets.set(market.id, market);
    return market;
  },
  updateMarket(id: ID, patch: Partial<Market>): Market | undefined {
    const market = store.markets.get(id);
    if (!market) return undefined;
    const next = { ...market, ...patch };
    store.markets.set(id, next);
    return next;
  },
  deleteMarket(id: ID): boolean {
    for (const bet of [...store.bets.values()]) {
      if (bet.marketId === id) store.bets.delete(bet.id);
    }
    return store.markets.delete(id);
  },

  // ---- Bets ------------------------------------------------------------
  listBetsForMarket(marketId: ID): Bet[] {
    return [...store.bets.values()]
      .filter((b) => b.marketId === marketId)
      .sort((a, b) => a.createdAt - b.createdAt);
  },
  createBet(bet: Bet): Bet {
    store.bets.set(bet.id, bet);
    return bet;
  },
  updateBet(id: ID, patch: Partial<Bet>): Bet | undefined {
    const bet = store.bets.get(id);
    if (!bet) return undefined;
    const next = { ...bet, ...patch };
    store.bets.set(id, next);
    return next;
  },
};

/** Escape hatch for the seed helper. Avoid using elsewhere. */
export type { Store };
