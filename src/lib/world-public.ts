/**
 * Client-safe World Selfie Check constants (no secrets).
 */

export type WorldAction = "signup" | "resolve";

export const WORLD_ACTIONS = {
  signup: "signup",
  resolve: "resolve",
} as const satisfies Record<WorldAction, string>;

export function worldActionId(
  action: WorldAction,
  marketId?: string,
): string {
  if (action === "resolve") {
    if (!marketId) throw new Error("resolve action requires marketId");
    return `resolve-${marketId}`;
  }
  return WORLD_ACTIONS.signup;
}

export function worldAppId(): `app_${string}` | null {
  const id = process.env.NEXT_PUBLIC_WORLD_APP_ID?.trim();
  return id?.startsWith("app_") ? (id as `app_${string}`) : null;
}

export function worldRpId(): string | null {
  return process.env.NEXT_PUBLIC_WORLD_RP_ID?.trim() || null;
}

export function worldEnvironment(): "production" | "staging" | "sandbox" {
  const v = process.env.NEXT_PUBLIC_WORLD_ENVIRONMENT?.trim();
  if (v === "production" || v === "staging" || v === "sandbox") return v;
  return "sandbox";
}
