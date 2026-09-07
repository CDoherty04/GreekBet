/**
 * /api/groups/[groupId] — group details + its members.
 */

import { db } from "@/lib/store";
import { fail, ok } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";
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
  if (!group.memberIds.includes(user.id)) {
    return fail("You are not a member of this group", 403);
  }

  const members = group.memberIds
    .map((id) => db.getUser(id))
    .filter((u): u is User => Boolean(u));

  return ok({ group, members });
}
