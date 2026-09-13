/**
 * GET /api/agent/users/[userId]/groups — groups the user belongs to.
 */

import { ok } from "@/lib/http";
import { requireAgentApiKey } from "@/lib/agent/auth";
import { loadAgentUser } from "@/lib/agent/markets";
import { db } from "@/lib/store";

export async function GET(
  req: Request,
  ctx: RouteContext<"/api/agent/users/[userId]/groups">,
) {
  const denied = requireAgentApiKey(req);
  if (denied) return denied;

  const { userId } = await ctx.params;
  const user = await loadAgentUser(userId);
  if (user instanceof Response) return user;

  const groups = await db.listGroupsForUser(user.id);
  return ok({
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      ownerId: g.ownerId,
      memberCount: g.memberIds.length,
      createdAt: g.createdAt,
    })),
  });
}
