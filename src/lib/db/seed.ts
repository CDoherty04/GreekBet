/**
 * Demo seed data so the app has something to show on first load.
 *
 * Storage-adjacent, so it lives beside the store and is called once when the
 * store is created.
 *
 * **Only off-chain data is seeded.** A market cannot be faked into existence
 * here: it is an on-chain PDA with a real vault holding real collateral, and
 * the app learns about it from the indexer. Seeding a fake one would produce a
 * row the UI renders as pending forever, because no chain state will ever
 * arrive for it. So the demo group starts empty and its first market is created
 * for real, on chain, through the app.
 *
 * The demo users' wallets are generated on demand by
 * `src/lib/chain/wallet.ts` — the placeholder EVM-shaped strings that used to
 * be here could never have signed a Solana transaction.
 */

import type { Store } from "@/lib/store";
import type { Group, User } from "@/types";

export function seedDemoData(store: Store): void {
  const now = Date.now();

  const alice: User = {
    id: "u_alice",
    name: "Alice",
    phone: "+15550000001",
    avatarUrl: "",
    // Filled in on first sign-in, when the keypair is provisioned.
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
}
