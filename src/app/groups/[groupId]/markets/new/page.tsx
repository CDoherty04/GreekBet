"use client";

/** Create a yes/no market inside a group. */

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useRequireUser } from "@/components/SessionProvider";
import { api } from "@/lib/api";

const UNITS: { label: string; ms: number }[] = [
  { label: "minutes", ms: 60 * 1000 },
  { label: "hours", ms: 60 * 60 * 1000 },
  { label: "days", ms: 24 * 60 * 60 * 1000 },
];

export default function NewMarketPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const { user } = useRequireUser();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [durationValue, setDurationValue] = useState("1");
  const [unitIdx, setUnitIdx] = useState(2);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const amount = Math.max(1, Number(durationValue) || 0);
      const ms = amount * UNITS[unitIdx].ms;
      const { market } = await api.createMarket(groupId, {
        title,
        expiresAt: Date.now() + ms,
      });
      router.replace(`/markets/${market.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <TopBar title="New event" back />
      <div className="flex flex-1 flex-col gap-4 p-4">
        <TextField
          label="Question"
          name="title"
          placeholder="Will it rain at the BBQ? ☔️"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          hint="Phrase it as a yes/no question so it can resolve cleanly."
        />
        <div>
          <span className="mb-1.5 block label-hud">
            Betting closes in
          </span>
          <div className="flex gap-2">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={durationValue}
              onChange={(e) => setDurationValue(e.target.value.replace(/[^\d]/g, ""))}
              className="w-24 rounded-2xl border border-border bg-surface-2 px-4 py-3.5 text-base text-foreground outline-none focus:border-brand"
            />
            <select
              value={unitIdx}
              onChange={(e) => setUnitIdx(Number(e.target.value))}
              className="select-field flex-1 rounded-2xl border border-border bg-surface-2 px-4 py-3.5 text-base text-foreground outline-none focus:border-brand"
            >
              {UNITS.map((u, i) => (
                <option key={u.label} value={i}>
                  {u.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {error && <p className="text-sm text-no">{error}</p>}
        <div className="mt-auto">
          <Button
            loading={submitting}
            disabled={!title.trim() || Number(durationValue) < 1 || !user}
            onClick={submit}
          >
            Create market
          </Button>
        </div>
      </div>
    </div>
  );
}
