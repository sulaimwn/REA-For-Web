import type { Metadata } from "next";
import type { ReactNode } from "react";
// Self-hosted (OFL); see the design notes at the top of globals.css.
import "@fontsource-variable/atkinson-hyperlegible-next";
import "@fontsource-variable/atkinson-hyperlegible-mono";
import "./globals.css";
import { SITE_DESCRIPTION, SITE_NAME, shareMetadata } from "../lib/site";

export const metadata: Metadata = {
  metadataBase: new URL("https://reaforweb.com"),
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
  ...shareMetadata(SITE_NAME),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
