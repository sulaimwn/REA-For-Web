import type { Metadata } from "next";
import type { ReactNode } from "react";
// Self-hosted (OFL); see the design notes at the top of globals.css.
import "@fontsource-variable/atkinson-hyperlegible-next";
import "@fontsource-variable/atkinson-hyperlegible-mono";
import "./globals.css";

const DESCRIPTION =
  "See how an app is put together. Upload an Electron app, a Windows or Linux program or an Android APK and explore a map of its parts, with REA's evidence for each one.";

export const metadata: Metadata = {
  metadataBase: new URL("https://reaforweb.com"),
  title: "REA for Web",
  description: DESCRIPTION,
  openGraph: { title: "REA for Web", description: DESCRIPTION, url: "/", siteName: "REA for Web", type: "website" },
  twitter: { card: "summary", title: "REA for Web", description: DESCRIPTION },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
