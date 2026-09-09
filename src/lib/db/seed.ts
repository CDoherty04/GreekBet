/**
 * Demo seed data so the app has something to show on first load.
 *
 * This lives under `src/lib/db/` because it's storage-adjacent — when the
 * in-memory store is replaced by a real database, seeding logic belongs here
 * too. It is called once by `src/lib/store.ts` when the store is created.
 */

import type { Store } from "@/lib/store";
import type { Bet, Group, Market, User } from "@/types";

export function seedDemoData(store: Store): void {
  const now = Date.now();

  const alice: User = {
    id: "u_alice",
    name: "Alice",
    phone: "+15550000001",
    avatarUrl: "",
    walletAddress: "0xa11ce0000000000000000000000000000000a11c",
    worldId: "0xworld_alice",
    verified: true,
    balance: 500,
    createdAt: now - 1000 * 60 * 60,
  };
  const bob: User = {
    id: "u_bob",
    name: "Bob",
    phone: "+15550000002",
    avatarUrl: "",
    walletAddress: "0xb0b0000000000000000000000000000000000b0b",
    worldId: "0xworld_bob",
    verified: true,
    balance: 500,
    createdAt: now - 1000 * 60 * 55,
  };
  store.users.set(alice.id, alice);
  store.users.set(bob.id, bob);

  const group: Group = {
    id: "g_demo",
    name: "Roommates",
    code: "DEMO24",
    ownerId: alice.id,
    memberIds: [alice.id, bob.id],
    createdAt: now - 1000 * 60 * 50,
  };
  store.groups.set(group.id, group);

  const market: Market = {
    id: "m_burrito",
    groupId: group.id,
    title: "Will Charlie finish the whole burrito? 🌯",
    description: "Resolves YES if the plate is empty within 20 minutes.",
    createdBy: alice.id,
    createdAt: now - 1000 * 60 * 30,
    expiresAt: now + 1000 * 60 * 60 * 2,
    status: "open",
  };
  store.markets.set(market.id, market);

  const bets: Bet[] = [
    {
      id: "b_1",
      marketId: market.id,
      userId: bob.id,
      side: "yes",
      amount: 40,
      createdAt: now - 1000 * 60 * 20,
    },
    {
      id: "b_2",
      marketId: market.id,
      userId: bob.id,
      side: "no",
      amount: 25,
      createdAt: now - 1000 * 60 * 15,
    },
  ];
  for (const bet of bets) store.bets.set(bet.id, bet);
}
