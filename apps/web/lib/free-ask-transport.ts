import { FreeAskUnavailableError, type FreeChat } from '@rea-studio/ask/free';

export const FREE_ASK_SERVICE_ORIGIN = 'https://reaforweb.com';

/** Only the official upload site and HTTP loopback development use the remote service. */
export function remoteFreeAskOrigin(origin: string): boolean {
  if (origin === 'https://uploads.reaforweb.com') return true;
  try {
    const url = new URL(origin);
    return url.origin === origin && url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function freeAskEndpoint(origin: string): string {
  return remoteFreeAskOrigin(origin) ? `${FREE_ASK_SERVICE_ORIGIN}/api/ask/free` : '/api/ask/free';
}

/** Inference stays on Cloudflare; project tools still run beside the map in this browser. */
export function createFreeChat(origin: string, fetcher: typeof fetch = fetch): FreeChat {
  return async (request, signal) => {
    const response = await fetcher(freeAskEndpoint(origin), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
      credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string; response?: string; tool_calls?: [] };
    if (!response.ok) {
      const message = body.message ?? `Free questions failed (${response.status}).`;
      if ([403, 429, 503].includes(response.status)) throw new FreeAskUnavailableError(message);
      throw new Error(message);
    }
    return { response: body.response ?? '', tool_calls: body.tool_calls ?? [] };
  };
}
