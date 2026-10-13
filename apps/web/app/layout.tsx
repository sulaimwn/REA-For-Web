import type { Metadata } from "next";
import type { ReactNode } from "react";
// Self-hosted (OFL); see the design notes at the top of globals.css.
import "@fontsource-variable/atkinson-hyperlegible-next";
import "@fontsource-variable/atkinson-hyperlegible-mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "REA for Web",
  description: "See how an app is put together: Electron processes, preload bridges and IPC, or .NET types, calls and native code, with the evidence for each part.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
