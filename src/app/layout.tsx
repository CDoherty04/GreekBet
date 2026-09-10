import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, DM_Sans } from "next/font/google";
import "./globals.css";
import { AppProviders } from "@/components/AppProviders";
import { MobileFrame } from "@/components/MobileFrame";

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
});

const barlow = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-barlow",
});

export const metadata: Metadata = {
  title: "Groupbet",
  description: "Private prediction markets for your group.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#07080c",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${dmSans.variable} ${barlow.variable}`}>
      <body className="antialiased">
        <AppProviders>
          <MobileFrame>{children}</MobileFrame>
        </AppProviders>
      </body>
    </html>
  );
}
