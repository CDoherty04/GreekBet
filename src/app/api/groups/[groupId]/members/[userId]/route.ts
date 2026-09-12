/**
 * /api/groups/[groupId]/members/[userId] — owner removes a member.
 */

import { db } from "@/lib/store";
import { fail, ok } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";

export async function DELETE(
  _req: Request,
  ctx: RouteContext<"/api/groups/[groupId]/members/[userId]">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { groupId, userId } = await ctx.params;
  const group = await db.getGroup(groupId);
  if (!group) return fail("Group not found", 404);
  if (group.ownerId !== user.id) {
    return fail("Only the group owner can remove members", 403);
  }
  if (userId === group.ownerId) {
    return fail("The owner cannot be removed", 400);
  }
  if (!group.memberIds.includes(userId)) {
    return fail("Not a member of this group", 404);
  }

  await db.removeMember(groupId, userId);
  return ok({ ok: true as const });
}
