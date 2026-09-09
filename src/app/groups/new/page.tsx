"use client";

/** Create a new group; you become its first member + owner. */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useRequireUser } from "@/components/SessionProvider";
import { api } from "@/lib/api";

export default function NewGroupPage() {
  const { user } = useRequireUser();
  const router = useRouter();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const { group } = await api.createGroup(name);
      router.replace(`/groups/${group.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <TopBar title="New group" back />
      <div className="flex flex-1 flex-col gap-4 p-4">
        <TextField
          label="Group name"
          name="name"
          placeholder="Roommates, Fantasy League…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <p className="text-sm text-muted">
          You&apos;ll get a shareable invite link after it&apos;s created.
        </p>
        {error && <p className="text-sm text-no">{error}</p>}
        <div className="mt-auto">
          <Button
            loading={submitting}
            disabled={!name.trim() || !user}
            onClick={submit}
          >
            Create group
          </Button>
        </div>
      </div>
    </div>
  );
}
