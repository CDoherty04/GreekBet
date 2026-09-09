"use client";

import { useSession } from "@/components/SessionProvider";

/** Small pill showing the signed-in user's token balance. */
export function BalancePill() {
  const { user } = useSession();
  if (!user) return null;
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-3 py-1.5 font-display text-sm font-bold tracking-wide text-brand">
      {user.balance.toLocaleString()}
    </div>
  );
}
