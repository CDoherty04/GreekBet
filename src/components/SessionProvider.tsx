"use client";

/**
 * SessionProvider — makes the current user available to every screen.
 *
 * It no longer tracks a balance: money lives on chain, and `BalancePill` reads
 * it from the wallet directly. Caching it here would mean two sources of truth
 * for the same number, and the cached one would be wrong the moment a trade
 * settled.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import type { User } from "@/types";

interface SessionValue {
  user: User | null;
  loading: boolean;
  /** Re-fetch the session from the server. */
  refresh: () => Promise<void>;
  /** Optimistically replace the user (e.g. after signup or a balance change). */
  setUser: (user: User | null) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { user } = await api.getSession();
      setUser(user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Load the session once on mount (syncs React state with the server).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  return (
    <SessionContext.Provider value={{ user, loading, refresh, setUser }}>
      {children}
    </SessionContext.Provider>
  );
}

/** Access the session anywhere below the provider. */
export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within a SessionProvider");
  return ctx;
}

/**
 * Redirect to onboarding when there's no signed-in user. Returns the session
 * so screens can render a loading state while it resolves.
 */
export function useRequireUser(): SessionValue {
  const session = useSession();
  const router = useRouter();
  useEffect(() => {
    if (!session.loading && !session.user) router.replace("/onboarding");
  }, [session.loading, session.user, router]);
  return session;
}
