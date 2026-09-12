/**
 * Durable off-chain store — MongoDB.
 *
 * Groups, membership, user profiles, and market metadata (question text,
 * resolution photo). Money / prices / positions stay on chain.
 *
 * User profile fields that fit Privy's 1KB custom_metadata (name, wallet,
 * worldId, telegram) are mirrored there on write so Privy stays the identity
 * source of truth; Mongo remains authoritative for queries (by wallet/phone,
 * group membership, markets).
 */

import "server-only";

import type { Group, ID, Market, User } from "@/types";
import { getMongo } from "@/lib/db/mongo";
import { demoGroup, demoUsers } from "@/lib/db/seed";
import { normalizePhone } from "@/lib/phone";
import { privy, privyConfigured } from "@/lib/integrations/privy";

type UserDoc = User & { _id: string };
type GroupDoc = Group & { _id: string };
type MarketDoc = Market & { _id: string };

function stripId<T extends { _id?: string }>(doc: T): Omit<T, "_id"> {
  const { _id: _, ...rest } = doc;
  return rest;
}

async function users() {
  return (await getMongo()).collection<UserDoc>("users");
}
async function groups() {
  return (await getMongo()).collection<GroupDoc>("groups");
}
async function markets() {
  return (await getMongo()).collection<MarketDoc>("markets");
}

/** Best-effort mirror of profile fields onto Privy custom metadata. */
async function syncPrivyMetadata(user: User): Promise<void> {
  if (!privyConfigured()) return;
  try {
    const custom_metadata: Record<string, string | number | boolean> = {
      name: user.name,
      walletAddress: user.walletAddress,
      worldId: user.worldId,
      verified: user.verified,
    };
    if (user.telegramChatId) custom_metadata.telegramChatId = user.telegramChatId;
    if (user.telegramUsername) {
      custom_metadata.telegramUsername = user.telegramUsername;
    }
    await privy().users().setCustomMetadata(user.id, { custom_metadata });
  } catch (err) {
    console.error("privy custom_metadata sync failed", err);
  }
}

let seedPromise: Promise<void> | null = null;

/** Ensure DEMO24 exists (idempotent). */
async function ensureDemoSeed(): Promise<void> {
  if (!seedPromise) {
    seedPromise = (async () => {
      const g = await groups();
      const existing = await g.findOne({ code: "DEMO24" });
      if (existing) return;

      const now = Date.now();
      const [alice, bob] = demoUsers(now);
      const group = demoGroup(alice.id, [alice.id, bob.id], now);
      const u = await users();
      await u.updateOne(
        { _id: alice.id },
        { $setOnInsert: { ...alice, _id: alice.id } },
        { upsert: true },
      );
      await u.updateOne(
        { _id: bob.id },
        { $setOnInsert: { ...bob, _id: bob.id } },
        { upsert: true },
      );
      await g.updateOne(
        { _id: group.id },
        { $setOnInsert: { ...group, _id: group.id } },
        { upsert: true },
      );
    })().catch((err) => {
      seedPromise = null;
      throw err;
    });
  }
  await seedPromise;
}

export const db = {
  // ---- Users -----------------------------------------------------------
  async getUser(id: ID): Promise<User | undefined> {
    await ensureDemoSeed();
    const doc = await (await users()).findOne({ _id: id });
    if (!doc) return undefined;
    return { ...stripId(doc), id: doc.id ?? doc._id };
  },

  async getUserByPhone(phone: string): Promise<User | undefined> {
    await ensureDemoSeed();
    const needle = normalizePhone(phone);
    const doc = await (await users()).findOne({ phone: needle });
    if (!doc) {
      // Legacy rows may store un-normalized phones.
      const all = await (await users()).find({}).toArray();
      const hit = all.find((u) => normalizePhone(u.phone) === needle);
      if (!hit) return undefined;
      return { ...stripId(hit), id: hit.id ?? hit._id };
    }
    return { ...stripId(doc), id: doc.id ?? doc._id };
  },

  async getUserByWallet(walletAddress: string): Promise<User | undefined> {
    if (!walletAddress) return undefined;
    await ensureDemoSeed();
    const doc = await (await users()).findOne({ walletAddress });
    if (!doc) return undefined;
    return { ...stripId(doc), id: doc.id ?? doc._id };
  },

  async createUser(user: User): Promise<User> {
    await ensureDemoSeed();
    await (await users()).insertOne({ ...user, _id: user.id });
    void syncPrivyMetadata(user);
    return user;
  },

  async updateUser(id: ID, patch: Partial<User>): Promise<User | undefined> {
    await ensureDemoSeed();
    const col = await users();
    const result = await col.findOneAndUpdate(
      { _id: id },
      { $set: patch },
      { returnDocument: "after" },
    );
    if (!result) return undefined;
    const user: User = { ...stripId(result), id: result.id ?? result._id };
    void syncPrivyMetadata(user);
    return user;
  },

  // ---- Groups ----------------------------------------------------------
  async getGroup(id: ID): Promise<Group | undefined> {
    await ensureDemoSeed();
    const doc = await (await groups()).findOne({ _id: id });
    if (!doc) return undefined;
    return { ...stripId(doc), id: doc.id ?? doc._id };
  },

  async getGroupByCode(code: string): Promise<Group | undefined> {
    await ensureDemoSeed();
    const doc = await (await groups()).findOne({ code: code.toUpperCase() });
    if (!doc) return undefined;
    return { ...stripId(doc), id: doc.id ?? doc._id };
  },

  async listGroupsForUser(userId: ID): Promise<Group[]> {
    await ensureDemoSeed();
    const docs = await (await groups())
      .find({ memberIds: userId })
      .sort({ createdAt: -1 })
      .toArray();
    return docs.map((d) => ({ ...stripId(d), id: d.id ?? d._id }));
  },

  async createGroup(group: Group): Promise<Group> {
    await ensureDemoSeed();
    await (await groups()).insertOne({ ...group, _id: group.id });
    return group;
  },

  async addMember(groupId: ID, userId: ID): Promise<Group | undefined> {
    await ensureDemoSeed();
    const result = await (
      await groups()
    ).findOneAndUpdate(
      { _id: groupId },
      { $addToSet: { memberIds: userId } },
      { returnDocument: "after" },
    );
    if (!result) return undefined;
    return { ...stripId(result), id: result.id ?? result._id };
  },

  async removeMember(groupId: ID, userId: ID): Promise<Group | undefined> {
    await ensureDemoSeed();
    const result = await (
      await groups()
    ).findOneAndUpdate(
      { _id: groupId },
      { $pull: { memberIds: userId } },
      { returnDocument: "after" },
    );
    if (!result) return undefined;
    return { ...stripId(result), id: result.id ?? result._id };
  },

  // ---- Market metadata -------------------------------------------------
  async getMarket(address: string): Promise<Market | undefined> {
    await ensureDemoSeed();
    const doc = await (await markets()).findOne({ _id: address });
    if (!doc) return undefined;
    const { _id: _, ...rest } = doc;
    return rest as Market;
  },

  async listMarketsForGroup(groupId: ID): Promise<Market[]> {
    await ensureDemoSeed();
    const docs = await (await markets()).find({ groupId }).toArray();
    return docs
      .map((d) => {
        const { _id: _, ...rest } = d;
        return rest as Market;
      })
      .sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        return b.createdAt - a.createdAt;
      });
  },

  async createMarket(market: Market): Promise<Market> {
    await ensureDemoSeed();
    await (await markets()).insertOne({ ...market, _id: market.address });
    return market;
  },

  async updateMarket(
    address: string,
    patch: Partial<Market>,
  ): Promise<Market | undefined> {
    await ensureDemoSeed();
    // Clear fields set to `undefined` (e.g. wiping resolution on retake).
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ""> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) $unset[k] = "";
      else $set[k] = v;
    }
    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    if (!Object.keys(update).length) return this.getMarket(address);

    const result = await (
      await markets()
    ).findOneAndUpdate({ _id: address }, update, { returnDocument: "after" });
    if (!result) return undefined;
    const { _id: _, ...rest } = result;
    return rest as Market;
  },

  async deleteMarket(address: string): Promise<boolean> {
    await ensureDemoSeed();
    const res = await (await markets()).deleteOne({ _id: address });
    return res.deletedCount > 0;
  },
};

/** Claim a World nullifier (anti-replay). Returns false if already used. */
export async function claimWorldNullifier(
  action: string,
  nullifier: string,
): Promise<boolean> {
  try {
    await (await getMongo()).collection("world_nullifiers").insertOne({
      action,
      nullifier: nullifier.toLowerCase(),
      at: Date.now(),
    });
    return true;
  } catch (err) {
    // Duplicate key → already claimed.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: number }).code === 11000
    ) {
      return false;
    }
    throw err;
  }
}
