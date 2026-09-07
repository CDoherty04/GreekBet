"use client";

/** Home screen once signed in: the user's groups, plus create/join actions. */

import { useEffect, useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { BalancePill } from "@/components/BalancePill";
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
      <TopBar title="Your groups" right={<BalancePill />} />
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
          <Button variant="secondary">Join group</Button>
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
      <Card className="flex items-center justify-between transition hover:border-brand/60">
        <div>
          <p className="font-semibold">{group.name}</p>
          <p className="text-xs text-muted">
            {group.memberIds.length} member
            {group.memberIds.length === 1 ? "" : "s"} · code {group.code}
          </p>
        </div>
        <span className="text-muted">›</span>
      </Card>
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="mt-16 text-center text-muted">
      <div className="mb-2 text-3xl">👥</div>
      <p className="font-medium text-foreground">No groups yet</p>
      <p className="mt-1 text-sm">Create one or join with a code to start betting.</p>
    </div>
  );
}

function Splash() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-transparent" />
    </div>
  );
}
