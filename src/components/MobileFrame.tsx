/**
 * MobileFrame — centers the app in a phone-width column.
 *
 * On a phone it fills the screen; on desktop it shows a centered, phone-sized
 * column so the mobile-first layout still looks intentional. All screens
 * render inside this frame (wired up in the root layout).
 */
export function MobileFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh w-full bg-background flex justify-center">
      <main className="relative flex min-h-dvh w-full max-w-md flex-col bg-background sm:my-4 sm:min-h-[calc(100dvh-2rem)] sm:rounded-3xl sm:border sm:border-border sm:shadow-2xl sm:shadow-black/40 overflow-hidden">
        {children}
      </main>
    </div>
  );
}
