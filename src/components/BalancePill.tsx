"use client";

import { useSession } from "@/components/SessionProvider";

/** Small pill showing the signed-in user's token balance. */
export function BalancePill() {
  const { user } = useSession();
  if (!user) return null;
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 py-1.5 text-sm font-semibold">
      <span aria-hidden>🪙</span>
      <span>{user.balance.toLocaleString()}</span>
    </div>
  );
}
