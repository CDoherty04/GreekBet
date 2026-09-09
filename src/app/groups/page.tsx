"use client";

/** Home screen once signed in: the user's groups, plus create/join actions. */

import { useEffect, useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { BalancePill } from "@/components/BalancePill";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useRequireUser } from "@/components/SessionProvider";
import { api } from "@/lib/api";
import type { Group } from "@/types";

export default function GroupsPage() {
  const { user, loading } = useRequireUser();
  const [groups, setGroups] = useState<Group[] | null>(null);

  useEffect(() => {
    if (!user) return;
    api.listGroups().then((r) => setGroups(r.groups)).catch(() => setGroups([]));
  }, [user]);

  if (loading || !user) return <Splash />;

  return (
    <div className="flex flex-1 flex-col">
      <TopBar
        title="Your Groups"
        right={
          <div className="flex items-center gap-2">
            <BalancePill />
            <Link
              href="/debug"
              className="font-display text-[10px] font-bold tracking-[0.16em] uppercase text-muted hover:text-brand"
            >
              Debug
            </Link>
            <Avatar />
          </div>
        }
      />
      <div className="flex-1 space-y-3 overflow-y-auto p-4 no-scrollbar">
        {groups === null ? (
          <Splash />
        ) : groups.length === 0 ? (
          <EmptyState />
        ) : (
          groups.map((g) => <GroupRow key={g.id} group={g} />)
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 border-t border-border p-4">
        <Link href="/groups/join">
          <Button variant="secondary">Join</Button>
        </Link>
        <Link href="/groups/new">
          <Button>New group</Button>
        </Link>
      </div>
    </div>
  );
}

function GroupRow({ group }: { group: Group }) {
  return (
    <Link href={`/groups/${group.id}`} className="block">
      <Card className="flex items-center justify-between transition hover:border-brand/50">
        <div>
          <p className="font-display text-lg font-bold uppercase tracking-wide">
            {group.name}
          </p>
          <p className="label-hud mt-1">
            {group.memberIds.length} member
            {group.memberIds.length === 1 ? "" : "s"}
          </p>
        </div>
        <span className="font-display text-xl text-brand">›</span>
      </Card>
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="mt-16 text-center">
      <p className="font-display text-2xl font-extrabold uppercase">No groups yet</p>
      <p className="mt-2 text-sm text-muted">
        Create one or join with a code to start racing.
      </p>
    </div>
  );
}

function Splash() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
    </div>
  );
}
