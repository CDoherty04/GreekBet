"use client";

/**
 * SessionProvider — Privy auth + app profile.
 *
 * Privy holds the SMS session and Solana wallet. This provider loads the
 * Groupbet user row (name / selfie / World) once Privy reports authenticated.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { api, setAccessTokenProvider } from "@/lib/api";
import type { User } from "@/types";

interface SessionValue {
  user: User | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setUser: (user: User | null) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setAccessTokenProvider(async () => {
      if (!authenticated) return null;
      try {
        return await getAccessToken();
      } catch {
        return null;
      }
    });
    return () => setAccessTokenProvider(null);
  }, [authenticated, getAccessToken]);

  const refresh = useCallback(async () => {
    if (!ready) return;
    if (!authenticated) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const { user: next } = await api.getSession();
      setUser(next);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [ready, authenticated]);

  useEffect(() => {
    if (!ready) return;
    setLoading(true);
    void refresh();
  }, [ready, authenticated, refresh]);

  // Expose logout helper via window-free pattern: SessionProvider consumers
  // call api.signOut + privy.logout from UI. Keep logout available through
  // a stable refresh after Privy logout by clearing user when unauthenticated.

  useEffect(() => {
    if (ready && !authenticated && user) setUser(null);
  }, [ready, authenticated, user, setUser]);

  return (
    <SessionContext.Provider value={{ user, loading: loading || !ready, refresh, setUser }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within a SessionProvider");
  return ctx;
}

export function useRequireUser(): SessionValue {
  const session = useSession();
  const router = useRouter();
  useEffect(() => {
    if (!session.loading && !session.user) router.replace("/onboarding");
  }, [session.loading, session.user, router]);
  return session;
}
