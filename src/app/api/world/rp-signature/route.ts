/**
 * POST /api/world/rp-signature — sign an IDKit request with the RP key.
 * Never expose WORLD_RP_SIGNING_KEY to the client.
 */

import { fail, ok, readJson } from "@/lib/http";
import { getPrivyId } from "@/lib/session";
import {
  WORLD_ACTIONS,
  createRpSignature,
  getWorldPublicConfig,
  worldActionId,
  type WorldAction,
} from "@/lib/integrations/world";

interface Body {
  action?: string;
  marketId?: string;
}

export async function GET() {
  return ok(getWorldPublicConfig());
}

export async function POST(req: Request) {
  const privyId = await getPrivyId();
  if (!privyId) return fail("Not signed in", 401);

  const body = await readJson<Body>(req);
  if (!body) return fail("Invalid JSON body");
  const action = body.action as WorldAction | undefined;
  if (!action || !(action in WORLD_ACTIONS)) {
    return fail('action must be "signup" or "resolve"');
  }
  if (action === "resolve" && !body.marketId) {
    return fail("marketId is required for resolve");
  }

  try {
    const payload = createRpSignature(
      worldActionId(action, body.marketId),
    );
    return ok(payload);
  } catch (err) {
    console.error("[world/rp-signature]", err);
    return fail(
      err instanceof Error ? err.message : "Could not sign World request",
      500,
    );
  }
}
