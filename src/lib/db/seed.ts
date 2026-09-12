/**
 * Demo seed helpers (DEMO24 group). Invoked from the Mongo store on first use.
 */

import type { Group, User } from "@/types";

export function demoUsers(now = Date.now()): [User, User] {
  const alice: User = {
    id: "u_alice",
    name: "Alice",
    phone: "+15550000001",
    avatarUrl: "",
    walletAddress: "",
    worldId: "0xworld_alice",
    verified: true,
    createdAt: now - 1000 * 60 * 60,
  };
  const bob: User = {
    id: "u_bob",
    name: "Bob",
    phone: "+15550000002",
    avatarUrl: "",
    walletAddress: "",
    worldId: "0xworld_bob",
    verified: true,
    createdAt: now - 1000 * 60 * 55,
  };
  return [alice, bob];
}

export function demoGroup(ownerId: string, memberIds: string[], now = Date.now()): Group {
  return {
    id: "g_demo",
    name: "Roommates",
    code: "DEMO24",
    ownerId,
    memberIds,
    createdAt: now - 1000 * 60 * 50,
  };
}
