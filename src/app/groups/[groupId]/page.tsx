"use client";

/**
 * Group detail — share the invite code, see members, browse & create markets.
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
  const [members, setMembers] = useState<User[]>([]);
  const [markets, setMarkets] = useState<MarketView[] | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const [{ group, members }, { markets }] = await Promise.all([
      api.getGroup(groupId),
      api.listMarkets(groupId),
    ]);
    setGroup(group);
    setMembers(members);
    setMarkets(markets);
  }, [groupId]);

  useEffect(() => {
    // Fetch-on-mount: load group + markets once the user is known.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (user) void load().catch(() => setMarkets([]));
  }, [user, load]);

  const share = useCallback(async () => {
    if (!group) return;
    const text = `Join my Groupbet group "${group.name}" with code ${group.code}`;
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(group.code);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      /* user cancelled share */
    }
  }, [group]);

  if (loading || !user || !group) return <Splash />;

  return (
    <div className="flex flex-1 flex-col">
      <TopBar title={group.name} back right={<BalancePill />} />
      <div className="flex-1 space-y-4 overflow-y-auto p-4 no-scrollbar">
        {/* Invite code */}
        <Card className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted">Invite code</p>
            <p className="text-2xl font-bold tracking-[0.2em]">{group.code}</p>
          </div>
          <Button variant="secondary" fullWidth={false} onClick={share}>
            {copied ? "Copied!" : "Share"}
          </Button>
        </Card>

        {/* Members */}
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            Members · {members.length}
          </p>
          <div className="flex flex-wrap gap-2">
            {members.map((m) => (
              <span
                key={m.id}
                className="rounded-full border border-border bg-surface-2 px-3 py-1.5 text-sm"
              >
                {m.name}
                {m.id === user.id && " (you)"}
              </span>
            ))}
          </div>
        </div>

        {/* Markets */}
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            Markets
          </p>
          {markets === null ? (
            <Splash />
          ) : markets.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted">
              No markets yet — create the first one.
            </p>
          ) : (
            <div className="space-y-3">
              {markets.map((m) => (
                <MarketCard key={m.id} market={m} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border p-4">
        <Link href={`/groups/${groupId}/markets/new`}>
          <Button>+ New market</Button>
        </Link>
      </div>
    </div>
  );
}

function Splash() {
  return (
    <div className="flex flex-1 items-center justify-center py-16">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-transparent" />
    </div>
  );
}
