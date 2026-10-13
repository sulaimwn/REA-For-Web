import type { Metadata } from "next";
import type { ReactNode } from "react";
// Self-hosted (OFL); see the design notes at the top of globals.css.
import "@fontsource-variable/atkinson-hyperlegible-next";
import "@fontsource-variable/atkinson-hyperlegible-mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "REA Studio",
  description: "See how an Electron app is put together: processes, windows, preload bridges, IPC and native code, with the evidence for each part.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
