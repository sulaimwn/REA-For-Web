// /api/ask/free (T030): one free-tier model call for the Ask panel, on Cloudflare Workers AI.
// The browser runs the tool loop; this route only accepts that conversation, adds the fixed system prompt
// and Ask tool list, and calls the free model. Guards: same-origin requests only, bounded input, a
// per-visitor rate limit, and Workers AI's daily allocation on the Workers Free plan. Paid plans can bill.
import {
  FREE_ASK_LIMITS, FREE_ASK_MODEL, FREE_ASK_SYSTEM_PROMPT, freeAskTools,
  type FreeChatResponse, type FreeMessage,
} from '@rea-studio/ask/free';

const MAX_BODY_BYTES = 64 * 1024;
/** Model calls per visitor per minute and per day, counted in this isolate (best effort across the edge). */
const PER_MINUTE = 12;
const PER_DAY = 120;

export interface FreeAskEnv {
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  /** Optional Cloudflare rate-limiting binding (`ratelimits` in wrangler.jsonc), if the account has it. */
  ASK_FREE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status: number, error: string, message: string) => json(status, { error, message });

const counters = new Map<string, { minute: number; minuteCount: number; day: number; dayCount: number }>();
/** In-isolate limiter; exported for tests. */
export function allowFreeAsk(key: string, now = Date.now()): boolean {
  const minute = Math.floor(now / 60_000);
  const day = Math.floor(now / 86_400_000);
  const c = counters.get(key) ?? { minute, minuteCount: 0, day, dayCount: 0 };
  if (c.minute !== minute) { c.minute = minute; c.minuteCount = 0; }
  if (c.day !== day) { c.day = day; c.dayCount = 0; }
  if (c.minuteCount >= PER_MINUTE || c.dayCount >= PER_DAY) return false;
  c.minuteCount++;
  c.dayCount++;
  counters.set(key, c);
  if (counters.size > 10_000) counters.clear(); // bound memory; a reset only loosens the limit briefly
  return true;
}

async function boundedText(request: Request): Promise<string | null> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BODY_BYTES)) return null;
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/** Validates the browser's conversation; returns an error message, or the messages. */
export function parseFreeAskBody(value: unknown): { messages: FreeMessage[]; final: boolean } | string {
  const body = value as { messages?: unknown; final?: unknown } | null;
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return 'Expected { messages, final }.';
  const messages = body.messages as unknown[];
  if (messages.length < 1 || messages.length > FREE_ASK_LIMITS.maxMessages) return 'Too many messages.';
  let total = 0;
  let totalBytes = 0;
  const clean: FreeMessage[] = [];
  for (const [i, m] of messages.entries()) {
    const { role, content } = (m ?? {}) as { role?: unknown; content?: unknown };
    if (!['user', 'assistant', 'tool'].includes(role as string) || typeof content !== 'string') return 'Invalid message.';
    if (i === 0 && (role !== 'user' || content.length > FREE_ASK_LIMITS.maxQuestionChars)) return 'The first message must be a short question.';
    if (content.length > FREE_ASK_LIMITS.maxMessageChars) return 'A message is too long.';
    total += content.length;
    totalBytes += new TextEncoder().encode(content).byteLength;
    // Forward only validated fields; arbitrary browser-supplied message metadata stays out of inference.
    clean.push({ role: role as FreeMessage['role'], content });
  }
  if (total > FREE_ASK_LIMITS.maxTotalChars || totalBytes > FREE_ASK_LIMITS.maxTotalBytes) return 'The conversation is too long.';
  return { messages: clean, final: body.final === true };
}

/** Workers AI's function-calling reply → `{ response, tool_calls }` (arguments as objects). */
export function normalizeFreeReply(raw: unknown): FreeChatResponse {
  const r = (raw ?? {}) as { response?: unknown; tool_calls?: unknown };
  // Unknown names pass through (bounded): the browser answers them with an "Unknown tool" result.
  const toolCalls = (Array.isArray(r.tool_calls) ? r.tool_calls : []).slice(0, 3).flatMap((c: unknown) => {
    const { name, arguments: args } = (c ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof name !== 'string' || name.length === 0 || name.length > 64) return [];
    let parsed: unknown = args;
    if (typeof args === 'string') { try { parsed = JSON.parse(args); } catch { parsed = {}; } }
    return [{ name, arguments: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} }];
  });
  return { response: typeof r.response === 'string' ? r.response : '', tool_calls: toolCalls };
}

/**
 * The browser's Origin must be this site: its URL origin, or the Host it was addressed to (proxies and local
 * previews rewrite the request URL). Stops other websites from spending the allowance from their visitors'
 * browsers; non-browser clients are bounded by the rate and daily limits instead.
 */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) return false;
    return origin === new URL(request.url).origin || parsed.host === request.headers.get('host');
  } catch {
    return false;
  }
}

export async function handleFreeAsk(request: Request, env: FreeAskEnv): Promise<Response> {
  // Same-origin only: the free tier serves this site's Ask panel, not other sites or scripts.
  if (!sameOrigin(request)) return fail(403, 'forbidden', 'Free questions work only from this site’s Ask panel.');
  if (!env.AI) return fail(503, 'unavailable', 'Free questions aren’t available on this server. Use your own Claude key instead.');
  const text = await boundedText(request);
  if (text === null) return fail(413, 'too_large', 'This conversation is too large for the free tier.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail(400, 'bad_request', 'Invalid JSON.'); }
  const parsed = parseFreeAskBody(value);
  if (typeof parsed === 'string') return fail(400, 'bad_request', parsed);

  const visitor = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (env.ASK_FREE_LIMITER && !(await env.ASK_FREE_LIMITER.limit({ key: `ask-free:${visitor}` })).success) {
    return fail(429, 'rate_limited', 'Too many free questions at once. Wait a minute, or use your own Claude key.');
  }
  if (!allowFreeAsk(visitor)) return fail(429, 'rate_limited', 'You’ve reached the free question limit for now. Wait a minute, or use your own Claude key.');

  try {
    const raw = await env.AI.run(FREE_ASK_MODEL, {
      messages: [{ role: 'system', content: FREE_ASK_SYSTEM_PROMPT }, ...parsed.messages],
      ...(parsed.final ? {} : { tools: freeAskTools() }),
      max_tokens: FREE_ASK_LIMITS.maxAnswerTokens,
    });
    return json(200, normalizeFreeReply(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Workers Free rejects requests past its daily allocation (4006). Paid accounts may bill overages.
    if (/4006|daily free allocation|neurons/iu.test(message)) {
      return fail(429, 'exhausted', 'Today’s free questions are used up. They reset at midnight UTC; you can also use your own Claude key.');
    }
    return fail(502, 'model_error', 'The free model didn’t answer. Try again in a moment.');
  }
}
