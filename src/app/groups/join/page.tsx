"use client";

/** Join an existing group with its 6-character invite code. */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useRequireUser } from "@/components/SessionProvider";
import { api } from "@/lib/api";

export default function JoinGroupPage() {
  const { user } = useRequireUser();
  const router = useRouter();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (code.trim().length < 4) return;
    setSubmitting(true);
    setError(null);
    try {
      const { group } = await api.joinGroup(code);
      router.replace(`/groups/${group.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <TopBar title="Join group" back />
      <div className="flex flex-1 flex-col gap-4 p-4">
        <TextField
          label="Invite code"
          name="code"
          placeholder="K7QP2M"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={6}
          autoCapitalize="characters"
          autoFocus
          className="text-center text-2xl font-bold tracking-[0.3em]"
        />
        <p className="text-sm text-muted">
          Ask a group member for their 6-character code.
        </p>
        {error && <p className="text-sm text-no">{error}</p>}
        <div className="mt-auto">
          <Button
            loading={submitting}
            disabled={code.trim().length < 4 || !user}
            onClick={submit}
          >
            Join group
          </Button>
        </div>
      </div>
    </div>
  );
}
