/**
 * MobileFrame — centers the app in a phone-width column.
 *
 * On a phone it fills the screen; on desktop it shows a centered, phone-sized
 * column so the mobile-first layout still looks intentional.
 */
export function MobileFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh w-full justify-center bg-[#040506]">
      <main className="relative flex min-h-dvh w-full max-w-md flex-col overflow-hidden bg-background sm:my-4 sm:min-h-[calc(100dvh-2rem)] sm:rounded-[2rem] sm:border sm:border-border sm:shadow-2xl sm:shadow-black/50">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(124,92,255,0.12),_transparent_55%)]"
        />
        <div aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-brand" />
        <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
      </main>
    </div>
  );
}
