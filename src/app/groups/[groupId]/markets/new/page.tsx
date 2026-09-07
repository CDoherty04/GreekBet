"use client";

/** Create a yes/no market inside a group. */

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useRequireUser } from "@/components/SessionProvider";
import { api } from "@/lib/api";

const DURATIONS: { label: string; ms: number }[] = [
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "6 hours", ms: 6 * 60 * 60 * 1000 },
  { label: "1 day", ms: 24 * 60 * 60 * 1000 },
  { label: "3 days", ms: 3 * 24 * 60 * 60 * 1000 },
];

export default function NewMarketPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const { user } = useRequireUser();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [durationIdx, setDurationIdx] = useState(2);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const { market } = await api.createMarket(groupId, {
        title,
        description: description || undefined,
        expiresAt: Date.now() + DURATIONS[durationIdx].ms,
      });
      router.replace(`/markets/${market.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <TopBar title="New market" back />
      <div className="flex flex-1 flex-col gap-4 p-4">
        <TextField
          label="Question"
          name="title"
          placeholder="Will it rain at the BBQ? ☔️"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
        <TextField
          label="Resolution rule (optional)"
          name="description"
          placeholder="Resolves YES if it rains before 6pm."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">
            Betting closes in
          </span>
          <div className="grid grid-cols-4 gap-2">
            {DURATIONS.map((d, i) => (
              <button
                key={d.label}
                onClick={() => setDurationIdx(i)}
                className={[
                  "rounded-xl border px-2 py-2.5 text-sm font-medium transition",
                  i === durationIdx
                    ? "border-brand bg-brand/15 text-foreground"
                    : "border-border bg-surface-2 text-muted",
                ].join(" ")}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="text-sm text-no">{error}</p>}
        <div className="mt-auto">
          <Button
            loading={submitting}
            disabled={!title.trim() || !user}
            onClick={submit}
          >
            Create market
          </Button>
        </div>
      </div>
    </div>
  );
}
