// Free Ask tier (T030): see lib/free-ask.ts. Runs on Cloudflare with the Workers AI binding (`AI`);
// The upload host and local preview call the canonical Cloudflare endpoint directly.
import { handleFreeAsk, handleFreeAskOptions, type FreeAskEnv } from '../../../../lib/free-ask';

export const dynamic = 'force-dynamic';

async function cloudflareEnv(): Promise<FreeAskEnv> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    return getCloudflareContext().env as FreeAskEnv;
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  return handleFreeAsk(request, await cloudflareEnv());
}

export function OPTIONS(request: Request) {
  return handleFreeAskOptions(request);
}
