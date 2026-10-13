// OpenNext adapter config for Cloudflare Workers.
// Every page is prerendered at build time (no ISR/revalidation), so serve those
// prerendered pages from Workers static assets via the read-only static-assets cache.
// If server features later need revalidation (e.g. the upload pipeline), switch to an
// R2 incremental cache.
import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import staticAssetsIncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache';

export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
  enableCacheInterception: true,
});
