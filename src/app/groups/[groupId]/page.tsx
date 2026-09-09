"use client";

/**
 * Group detail — live markets only. Members + invite live in a submenu.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { BalancePill } from "@/components/BalancePill";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { MarketCard } from "@/components/MarketCard";
import { useRequireUser } from "@/components/SessionProvider";
import { api } from "@/lib/api";
import type { Group, MarketView } from "@/types";

export default function GroupDetailPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const { user, loading } = useRequireUser();
  const [group, setGroup] = useState<Group | null>(null);
  const [isMember, setIsMember] = useState(false);
  const [memberCount, setMemberCount] = useState(0);
  const [markets, setMarkets] = useState<MarketView[] | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const preview = await api.getGroup(groupId);
    setGroup(preview.group);
    setIsMember(preview.isMember);
    setMemberCount(preview.memberCount);
    if (preview.isMember) {
      const { markets } = await api.listMarkets(groupId);
      setMarkets(markets);
    } else {
      setMarkets([]);
    }
  }, [groupId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (user) void load().catch(() => setError("Could not load group"));
  }, [user, load]);

  async function join() {
    setJoining(true);
    setError(null);
    try {
      await api.joinGroupById(groupId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not join");
    } finally {
      setJoining(false);
    }
  }

  if (loading || !user || !group) return <Splash />;

  if (!isMember) {
    return (
      <div className="flex flex-1 flex-col">
        <TopBar title={group.name} back />
        <div className="flex flex-1 flex-col justify-center gap-4 p-6">
          <p className="label-hud">Invite</p>
          <h2 className="font-display text-3xl font-extrabold uppercase leading-none">
            {group.name}
          </h2>
          <p className="text-sm text-muted">
            {memberCount} member{memberCount === 1 ? "" : "s"} already racing.
            Join to bet on this group&apos;s markets.
          </p>
          {error && <p className="text-sm text-no">{error}</p>}
          <Button loading={joining} onClick={join}>
            Join group
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <TopBar
        title={group.name}
        back
        right={
          <div className="flex items-center gap-2">
            <BalancePill />
            <Link
              href={`/groups/${groupId}/invite`}
              aria-label="Members and invite"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-2 text-brand hover:border-brand"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="2" />
                <path
                  d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </Link>
          </div>
        }
      />
      <div className="flex-1 space-y-3 overflow-y-auto p-4 no-scrollbar">
        <p className="label-hud">Markets</p>
        {markets === null ? (
          <Splash />
        ) : markets.length === 0 ? (
          <Card className="py-10 text-center">
            <p className="font-display text-lg font-bold uppercase">No events yet</p>
            <p className="mt-1 text-sm text-muted">Create the first.</p>
          </Card>
        ) : (
          markets.map((m) => <MarketCard key={m.id} market={m} />)
        )}
      </div>

      <div className="border-t border-border p-4">
        <Link href={`/groups/${groupId}/markets/new`}>
          <Button>+ New event</Button>
        </Link>
      </div>
    </div>
  );
}

function Splash() {
  return (
    <div className="flex flex-1 items-center justify-center py-16">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
    </div>
  );
}
