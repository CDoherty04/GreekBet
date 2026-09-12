/**
 * /api/groups/join — join a group by its 6-character invite code.
 */

import { db } from "@/lib/store";
import { fail, ok, readJson } from "@/lib/http";
import { getCurrentUser } from "@/lib/session";

interface JoinBody {
  code: string;
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return fail("Not signed in", 401);

  const body = await readJson<JoinBody>(req);
  const code = body?.code?.trim().toUpperCase();
  if (!code) return fail("Invite code is required");

  const group = await db.getGroupByCode(code);
  if (!group) return fail("No group found for that code", 404);

  await db.addMember(group.id, user.id);
  return ok({ group });
}
