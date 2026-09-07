/**
 * /api/groups — list the current user's groups, or create a new one.
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { newGroupCode, newId } from "@/lib/ids";
import { getCurrentUser } from "@/lib/session";
import type { Group } from "@/types";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);
  return ok({ groups: db.listGroupsForUser(user.id) });
}

interface CreateGroupBody {
  name: string;
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const body = await readJson<CreateGroupBody>(req);
  if (!body?.name?.trim()) return fail("Group name is required");

  const group: Group = {
    id: newId("g"),
    name: body.name.trim(),
    code: uniqueCode(),
    ownerId: user.id,
    memberIds: [user.id],
    createdAt: Date.now(),
  };
  db.createGroup(group);
  return ok({ group }, { status: 201 });
}

/** Generate a group code, retrying on the (rare) chance of a collision. */
function uniqueCode(): string {
  for (let i = 0; i < 5; i++) {
    const code = newGroupCode();
    if (!db.getGroupByCode(code)) return code;
  }
  return newGroupCode();
}
