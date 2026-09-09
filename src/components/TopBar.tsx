"use client";

import { useRouter } from "next/navigation";

interface TopBarProps {
  title?: React.ReactNode;
  /** Show a back chevron on the left. */
  back?: boolean;
  /** Optional element rendered on the right (e.g. a balance pill). */
  right?: React.ReactNode;
  /** Center the title (e.g. for a live timer) instead of left-aligning it. */
  centerTitle?: boolean;
}

/** Sticky screen header with an optional back button. */
export function TopBar({ title, back, right, centerTitle }: TopBarProps) {
  const router = useRouter();
  return (
    <header className="relative sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/85 px-4 py-3 backdrop-blur">
      {centerTitle && title && (
        <div className="pointer-events-none absolute inset-x-0 flex justify-center">
          <span className="font-display text-sm font-bold tracking-widest text-brand">
            {title}
          </span>
        </div>
      )}
      {back && (
        <button
          onClick={() => router.back()}
          aria-label="Go back"
          className="-ml-1 flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-foreground"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path
              d="M15 18l-6-6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
      {title && !centerTitle && (
        <h1 className="flex-1 truncate font-display text-xl font-bold uppercase tracking-wide">
          {title}
        </h1>
      )}
      {(!title || centerTitle) && <div className="flex-1" />}
      {right}
    </header>
  );
}
