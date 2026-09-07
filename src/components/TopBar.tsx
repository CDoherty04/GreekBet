"use client";

import { useRouter } from "next/navigation";

interface TopBarProps {
  title?: string;
  /** Show a back chevron on the left. */
  back?: boolean;
  /** Optional element rendered on the right (e.g. a balance pill). */
  right?: React.ReactNode;
}

/** Sticky screen header with an optional back button. */
export function TopBar({ title, back, right }: TopBarProps) {
  const router = useRouter();
  return (
    <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/80 px-4 py-3 backdrop-blur">
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
      {title && (
        <h1 className="flex-1 truncate text-lg font-semibold">{title}</h1>
      )}
      {!title && <div className="flex-1" />}
      {right}
    </header>
  );
}
