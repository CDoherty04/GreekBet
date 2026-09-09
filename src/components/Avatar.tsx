"use client";

import { useSession } from "@/components/SessionProvider";

/** The signed-in user's selfie as a small round avatar. */
export function Avatar({ size = 32 }: { size?: number }) {
  const { user } = useSession();
  if (!user) return null;
  return (
    <div
      className="overflow-hidden rounded-full border-2 border-brand/60 bg-surface-2"
      style={{ width: size, height: size }}
    >
      {user.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={user.avatarUrl}
          alt={user.name}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-xs font-semibold text-muted">
          {user.name.charAt(0).toUpperCase()}
        </div>
      )}
    </div>
  );
}
