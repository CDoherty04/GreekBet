/**
 * /api/groups/[groupId] — group details + its members.
 *
 * Non-members can still fetch a public preview (name + member count) so an
 * invite link like `/groups/{id}` can show a Join screen.
 */

import { db } from "@/lib/store";
import { fail, ok } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
import { toMarketView } from "@/lib/markets";
import type { User } from "@/types";

export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/groups/[groupId]">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { groupId } = await ctx.params;
  const group = db.getGroup(groupId);
  if (!group) return fail("Group not found", 404);

  const isMember = group.memberIds.includes(user.id);

  const members = group.memberIds
    .map((id) => db.getUser(id))
    .filter((u): u is User => Boolean(u));

  const markets = db
    .listMarketsForGroup(groupId)
    .filter((m) => !m.archived)
    .map(toMarketView);

  if (!isMember) {
    const publicMembers = members.map((u) => ({
      ...u,
      phone: "",
      walletAddress: "",
      worldId: "",
      balance: 0,
    }));
    return ok({
      group: { ...group, code: "", memberIds: [] },
      members: publicMembers,
      markets,
      isMember: false,
      memberCount: members.length,
    });
  }

  return ok({
    group,
    members,
    markets,
    isMember: true,
    memberCount: members.length,
  });
}
