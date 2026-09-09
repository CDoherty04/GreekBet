"use client";

import { useEffect, useState } from "react";

/** Ticking clock so live vs expired UI stays in sync. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Format a millisecond duration as "2d 3h", "3h 12m", "12m 05s", etc. */
function format(ms: number): string {
  if (ms <= 0) return "Needs resolution";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** Live countdown to a timestamp, ticking every second. */
export function Countdown({
  expiresAt,
  className = "",
}: {
  expiresAt: number;
  className?: string;
}) {
  const now = useNow();
  return <span className={className}>{format(expiresAt - now)}</span>;
}
