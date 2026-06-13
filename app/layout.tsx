import type { Metadata } from "next";
import {
  Geist,
  Geist_Mono,
  Space_Grotesk,
  Instrument_Sans,
  JetBrains_Mono,
} from "next/font/google";
import "./globals.css";
import "./bliink-ui.css";
import AppShell from "./components/AppShell";
import TransferListener from "./components/TransferListener";
import ChatListener from "./components/ChatListener";
import IncomingRequestDialog from "./components/IncomingRequestDialog";
import CallOverlay from "./components/CallOverlay";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Design-system type families (self-hosted at build time → work offline).
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const instrumentSans = Instrument_Sans({
  variable: "--font-instrument-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Bliink",
  description: "Super-fast, secure file transfers",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} ${instrumentSans.variable} ${jetbrainsMono.variable} antialiased h-screen overflow-hidden`}
      >
        {/* Global listeners + overlays live outside the window chrome */}
        <TransferListener />
        <ChatListener />
        <IncomingRequestDialog />
        <CallOverlay />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
