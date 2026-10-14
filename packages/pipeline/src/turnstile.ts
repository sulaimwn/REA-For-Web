import { PipelineError } from './contracts.js';

export type PublicChallenge = { siteKey: string; secret: string; hostname: string };
export async function verifyChallenge(token: string | null, config: PublicChallenge,
  fetcher: typeof fetch = fetch, timeoutMs = 5000,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
    throw new Error('Invalid challenge deadline.');
  if (!token || token.length > 2048)
    throw new PipelineError(403, 'Complete the upload security check and try again.');
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The race covers both headers and the full bounded body, even if an injected
  // transport ignores abort. No redirect, retry, IP disclosure or provider log.
  const validate = async () => {
    const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: config.secret, response: token }),
    });
    controller.signal.throwIfAborted();
    if (!response.ok || !response.body) throw new Error('Challenge service unavailable.');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8192) throw new Error('Challenge response too large.');
      chunks.push(value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    if (result.success !== true || result.hostname !== config.hostname || result.action !== 'upload-app')
      throw new PipelineError(403, 'Complete a fresh upload security check and try again.');
  };
  try {
    await Promise.race([validate(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Challenge deadline.')); }, timeoutMs);
    })]);
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    throw new PipelineError(503, 'Upload security check is unavailable.');
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Cancellation need not settle before our deadline is honored.
    void reader?.cancel().catch(() => {});
  }
}
