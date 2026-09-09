"use client";

/**
 * Group submenu — members list. Share lives in the top bar.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { Card } from "@/components/ui/Card";
import { useRequireUser } from "@/components/SessionProvider";
import { api } from "@/lib/api";
import type { Group, User } from "@/types";

export default function GroupInvitePage() {
  const { groupId } = useParams<{ groupId: string }>();
  const { user, loading } = useRequireUser();
  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<User[]>([]);
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { group, members, isMember } = await api.getGroup(groupId);
    if (!isMember) throw new Error("Not a member");
    setGroup(group);
    setMembers(members);
  }, [groupId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (user) void load().catch(() => setError("Could not load squad"));
  }, [user, load]);

  async function share() {
    const url = `${window.location.origin}/groups/${groupId}`;
    try {
      if (navigator.share) {
        await navigator.share({ url, title: group?.name });
      } else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      /* user cancelled share */
    }
  }

  async function removeMember(member: User) {
    if (!window.confirm(`Remove ${member.name} from this group?`)) return;
    setRemoving(member.id);
    setError(null);
    try {
      await api.removeMember(groupId, member.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove member");
    } finally {
      setRemoving(null);
    }
  }

  if (loading || !user || !group) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <TopBar
        title="Squad"
        back
        right={
          <button
            onClick={share}
            aria-label="Share group"
            className="flex items-center gap-1.5 rounded-full border border-border bg-surface-2 py-1 pl-2.5 pr-2 text-muted hover:border-brand hover:text-foreground"
          >
            <span className="font-display text-xs font-bold tracking-[0.18em]">
              {copied ? "COPIED" : group.code}
            </span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <path
                d="M12 16V4M8 8l4-4 4 4"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        }
      />
      <div className="flex-1 space-y-3 overflow-y-auto p-4 no-scrollbar">
        <p className="label-hud">Members · {members.length}</p>
        {members.map((m) => (
          <Card key={m.id} className="flex items-center gap-3 py-3">
            <MemberAvatar user={m} />
            <p className="min-w-0 flex-1 truncate font-display text-base font-bold uppercase tracking-wide">
              {m.name}
              {m.id === group.ownerId ? " · owner" : ""}
              {m.id === user.id ? " · you" : ""}
            </p>
            {user.id === group.ownerId && m.id !== group.ownerId && (
              <button
                type="button"
                disabled={removing === m.id}
                onClick={() => void removeMember(m)}
                className="shrink-0 font-display text-[11px] font-bold tracking-[0.16em] uppercase text-no disabled:opacity-40"
              >
                {removing === m.id ? "…" : "Remove"}
              </button>
            )}
          </Card>
        ))}
        {error && <p className="text-sm text-no">{error}</p>}
      </div>
    </div>
  );
}

function MemberAvatar({ user }: { user: User }) {
  return (
    <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full border-2 border-brand/50 bg-surface-2">
      {user.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={user.avatarUrl}
          alt={user.name}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center font-display text-sm font-bold text-brand">
          {user.name.charAt(0).toUpperCase()}
        </div>
      )}
    </div>
  );
}
