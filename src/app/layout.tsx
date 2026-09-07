import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SessionProvider } from "@/components/SessionProvider";
import { MobileFrame } from "@/components/MobileFrame";

export const metadata: Metadata = {
  title: "Groupbet",
  description: "Private prediction markets for your group.",
};

// Mobile-first: lock the viewport to device width and theme the browser chrome.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0b0b12",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="antialiased">
        <SessionProvider>
          <MobileFrame>{children}</MobileFrame>
        </SessionProvider>
      </body>
    </html>
  );
}
