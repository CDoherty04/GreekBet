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
import type { Group, MarketView, User } from "@/types";

export default function GroupDetailPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const { user, loading } = useRequireUser();
  const [group, setGroup] = useState<Group | null>(null);
  const [isMember, setIsMember] = useState(false);
  const [memberCount, setMemberCount] = useState(0);
  const [members, setMembers] = useState<User[]>([]);
  const [markets, setMarkets] = useState<MarketView[] | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const preview = await api.getGroup(groupId);
    setGroup(preview.group);
    setIsMember(preview.isMember);
    setMemberCount(preview.memberCount);
    setMembers(preview.members);
    if (preview.isMember) {
      const { markets } = await api.listMarkets(groupId);
      setMarkets(markets);
    } else {
      setMarkets(preview.markets ?? []);
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
        <TopBar title="Join group" back />
        <div className="flex flex-1 flex-col overflow-y-auto p-6 no-scrollbar">
          <h2 className="font-display text-3xl font-extrabold uppercase leading-none">
            {group.name}
          </h2>
          <p className="mt-3 text-sm text-muted">
            {memberCount} member{memberCount === 1 ? "" : "s"} already in this
            group. Join to bet on this group&apos;s events.
          </p>
          {error && <p className="mt-3 text-sm text-no">{error}</p>}
          <div className="mt-5">
            <Button loading={joining} onClick={join}>
              Join group
            </Button>
          </div>

          <div className="mt-10 space-y-6">
            <div>
              <p className="label-hud mb-2">Members</p>
              {members.length === 0 ? (
                <p className="text-sm text-muted">No members yet.</p>
              ) : (
                <div className="space-y-2">
                  {members.map((m) => (
                    <Card key={m.id} className="flex items-center gap-3 py-3">
                      <div className="h-9 w-9 shrink-0 overflow-hidden rounded-full border border-border bg-surface-2">
                        {m.avatarUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={m.avatarUrl}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center font-display text-sm font-bold text-muted">
                            {m.name.charAt(0).toUpperCase()}
                          </div>
                        )}
                      </div>
                      <p className="truncate font-display text-base font-bold uppercase tracking-wide">
                        {m.name}
                      </p>
                    </Card>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className="label-hud mb-2">Events</p>
              {!markets || markets.length === 0 ? (
                <p className="text-sm text-muted">No events yet.</p>
              ) : (
                <div className="space-y-2">
                  {markets.map((m) => (
                    <Card key={m.address}>
                      <p className="font-display text-base font-bold leading-snug tracking-wide">
                        {m.title}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {!m.indexed
                          ? "Confirming on chain"
                          : m.status === "resolved"
                            ? "Resolved"
                            : m.expiresAt > Date.now()
                              ? "Live"
                              : "Needs resolution"}{" "}
                        · {m.trades.length} trade
                        {m.trades.length === 1 ? "" : "s"}
                      </p>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </div>
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
          markets.map((m) => <MarketCard key={m.address} market={m} />)
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
