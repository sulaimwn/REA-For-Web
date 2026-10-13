import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

// Required by @opennextjs/cloudflare (it looks for a Next.js config to build from).
const nextConfig: NextConfig = process.env.REA_NODE_DEPLOY === '1' ? {
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
} : {};

export default nextConfig;
