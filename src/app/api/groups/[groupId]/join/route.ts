/**
 * /api/groups/[groupId]/join — join via the group's shareable URL.
 */

import { db } from "@/lib/store";
import { fail, ok } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";

export async function POST(
  _req: Request,
  ctx: RouteContext<"/api/groups/[groupId]/join">,
) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const { groupId } = await ctx.params;
  const group = db.getGroup(groupId);
  if (!group) return fail("Group not found", 404);

  db.addMember(group.id, user.id);
  return ok({ group });
}
