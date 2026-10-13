// Free Ask tier (T030): see lib/free-ask.ts. Runs on Cloudflare with the Workers AI binding (`AI`);
// elsewhere (local dev, the Linux upload host) it answers 503 and the panel offers the Claude-key option.
import { handleFreeAsk, type FreeAskEnv } from '../../../../lib/free-ask';

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
