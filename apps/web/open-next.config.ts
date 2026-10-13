// OpenNext adapter config for Cloudflare Workers.
// The demo routes are prerendered without ISR/revalidation, so use the read-only
// static-assets cache for them. Upload/job routes are dynamic and do not use ISR.
// Hosting uploads still needs separate storage, queue and analysis-host setup.
// Add a writable incremental cache only if routes later need revalidation.
import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import staticAssetsIncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache';

export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
  enableCacheInterception: true,
});
