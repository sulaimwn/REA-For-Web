import type { Metadata } from 'next';

export const SITE_NAME = 'REA for Web';
export const SITE_DESCRIPTION =
  "See how an app is put together. Upload an Electron app, a Windows, Linux or macOS program or an Android APK and explore a map of its parts, with REA's evidence for each one.";

// public/og-image.png: the landing card over a crop of the GitHub Desktop demo.
const SHARE_IMAGE = {
  url: '/og-image.png',
  width: 1200,
  height: 630,
  alt: "A map of GitHub Desktop's parts in REA for Web: processes, IPC channels, native add-ons and storage keys, with analysis gaps marked.",
};

// Link-preview tags for a page. Next replaces a parent's openGraph/twitter objects (images
// included) instead of merging them, so every page that changes the title builds the full set here.
export function shareMetadata(title: string): Pick<Metadata, 'openGraph' | 'twitter'> {
  return {
    openGraph: { title, description: SITE_DESCRIPTION, siteName: SITE_NAME, type: 'website', images: [SHARE_IMAGE] },
    twitter: { card: 'summary_large_image', title, description: SITE_DESCRIPTION, images: [SHARE_IMAGE] },
  };
}
