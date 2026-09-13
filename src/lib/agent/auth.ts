/**
 * API-key gate for Bazantic / agent-facing routes.
 *
 * Agents do not have Privy session cookies. Set `AGENT_API_KEY` and pass it as
 * `Authorization: Bearer <key>` or `X-Api-Key: <key>`.
 */

import "server-only";

import { fail } from "@/lib/http";

export function agentApiKeyConfigured(): boolean {
  return Boolean(process.env.AGENT_API_KEY?.trim());
}

/** Extract the agent key from the request, or `null`. */
export function readAgentApiKey(req: Request): string | null {
  const apiKey = req.headers.get("x-api-key")?.trim();
  if (apiKey) return apiKey;

  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    return token || null;
  }
  return null;
}

/**
 * Validate the agent API key. Returns a 401/503 Response on failure, else null.
 */
export function requireAgentApiKey(req: Request): Response | null {
  const expected = process.env.AGENT_API_KEY?.trim();
  if (!expected) {
    return fail("Agent API is not configured (set AGENT_API_KEY)", 503);
  }
  const provided = readAgentApiKey(req);
  if (!provided || provided !== expected) {
    return fail("Invalid or missing agent API key", 401);
  }
  return null;
}
