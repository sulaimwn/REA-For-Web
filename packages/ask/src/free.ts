// The free Ask tier (T030): the same read-only tools, answered by an open model that the website runs on
// Cloudflare Workers AI's free daily allowance, so visitors need no API key.
//
// The tool loop runs in the browser, next to the project (which may be the visitor's own local file);
// only the conversation is sent to the site's /api/ask/free route. The route owns the system prompt and
// the tool list, so it can't be used as a general-purpose free chatbot. Loads no Anthropic SDK code.
import type { StudioProject } from '@rea-studio/schema';
import { citedNodeIds } from './cite.js';
import { indexGraph, type ProjectGraph } from './graph.js';
import { ASK_SYSTEM_PROMPT, STEP_LIMIT_NOTE } from './prompt.js';
import { ASK_TOOLS, runAskTool } from './tools.js';

/** Workers AI model with documented function calling (24k-token context). */
export const FREE_ASK_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const FREE_ASK_MODEL_LABEL = 'Llama 3.3 70B (free, open model)';

/** Limits the route enforces and the client respects, sized for the model's 24k-token context. */
export const FREE_ASK_LIMITS = {
  maxQuestionChars: 1_000,
  maxMessages: 24,
  /** Per message; tool results are truncated to fit. */
  maxMessageChars: 6_000,
  maxTotalChars: 48_000,
  /** UTF-8 budget also bounds multilingual input below the model context and the HTTP body limit. */
  // Even worst-case JSON escapes (six bytes per character) leave room in the 64 KiB request body.
  maxTotalBytes: 8_000,
  maxToolRounds: 5,
  maxAnswerTokens: 1_024,
} as const;

export type FreeMessage = { role: 'user' | 'assistant' | 'tool'; content: string };
export type FreeToolCall = { name: string; arguments: Record<string, unknown> };
export type FreeChatResponse = { response: string; tool_calls: FreeToolCall[] };
/** One model call through the site's route; `final` asks for an answer without tools. */
export type FreeChat = (request: { messages: FreeMessage[]; final: boolean }, signal?: AbortSignal) => Promise<FreeChatResponse>;

/** The tools in Workers AI's function-calling shape: `{ name, description, parameters }`. */
export function freeAskTools() {
  return ASK_TOOLS.map((t) => ({ name: t.name, description: t.description ?? '', parameters: t.input_schema }));
}

/** The free model's system prompt: Ask's, plus the plain-JSON tool-result convention it uses. */
export const FREE_ASK_SYSTEM_PROMPT = `${ASK_SYSTEM_PROMPT}

Tool results arrive as messages with role "tool", in the order you called the tools. Long results are cut short and say so.`;

export interface FreeAskOptions {
  chat: FreeChat;
  project: StudioProject | ProjectGraph;
  question: string;
  signal?: AbortSignal;
  onStep?: (step: { type: 'tool'; name: string; input: unknown } | { type: 'answering' }) => void;
}

export interface FreeAskResult {
  answer: string;
  citedNodeIds: string[];
  toolCalls: number;
  model: string;
}

/** Thrown when the free tier is unavailable or used up; the panel offers the Claude-key option instead. */
export class FreeAskUnavailableError extends Error {
  override name = 'FreeAskUnavailableError';
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).byteLength;
const CUT_NOTE = ' …[cut short: ask about a more specific node]';
/** Keep both UTF-16 character and UTF-8 byte limits; preserve complete surrogate pairs. */
function fit(text: string, maxChars: number, maxBytes: number): string {
  if (text.length <= maxChars && bytes(text) <= maxBytes) return text;
  let low = 0;
  let high = Math.min(text.length, maxChars - CUT_NOTE.length);
  const prefixBytes = maxBytes - bytes(CUT_NOTE);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes(text.slice(0, mid)) <= prefixBytes) low = mid;
    else high = mid - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(text[low - 1]!)) low--;
  return `${text.slice(0, low)}${CUT_NOTE}`;
}

export async function askProjectFree(opts: FreeAskOptions): Promise<FreeAskResult> {
  const graph = 'byId' in opts.project ? opts.project : indexGraph(opts.project);
  const question = opts.question.trim();
  if (!question) throw new Error('Ask a question first.');
  if (question.length > FREE_ASK_LIMITS.maxQuestionChars) throw new Error(`Keep free questions under ${FREE_ASK_LIMITS.maxQuestionChars} characters.`);
  const messages: FreeMessage[] = [{ role: 'user', content: question }];
  let toolCalls = 0;
  let budgetReached = false;
  for (let round = 0; ; round++) {
    opts.signal?.throwIfAborted();
    // Answer now if the context or round budget is spent.
    const final = budgetReached || round >= FREE_ASK_LIMITS.maxToolRounds
      || messages.length + 3 > FREE_ASK_LIMITS.maxMessages;
    if (final && round > 0) messages.push({ role: 'user', content: STEP_LIMIT_NOTE });
    const reply = await opts.chat({ messages, final }, opts.signal);
    // An unknown tool name gets runAskTool's "Unknown tool" result, so the model can correct itself.
    const calls = final ? [] : reply.tool_calls.filter((c) => typeof c.name === 'string' && c.name.length <= 64);
    if (calls.length === 0) {
      opts.onStep?.({ type: 'answering' });
      const answer = reply.response.trim();
      if (!answer) throw new Error('The free model returned no answer. Try a more specific question.');
      return { answer, citedNodeIds: citedNodeIds(answer, graph), toolCalls, model: FREE_ASK_MODEL };
    }
    for (const call of calls.slice(0, 3)) {
      const assistant = JSON.stringify({ name: call.name, arguments: call.arguments });
      const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
      const totalBytes = messages.reduce((n, m) => n + bytes(m.content), 0);
      // Reserve a final instruction before *each* call, including multi-call replies and large arguments.
      const roomChars = FREE_ASK_LIMITS.maxTotalChars - totalChars - assistant.length - STEP_LIMIT_NOTE.length;
      const roomBytes = FREE_ASK_LIMITS.maxTotalBytes - totalBytes - bytes(assistant) - bytes(STEP_LIMIT_NOTE);
      if (messages.length + 3 > FREE_ASK_LIMITS.maxMessages || assistant.length > FREE_ASK_LIMITS.maxMessageChars
        || roomChars < CUT_NOTE.length || roomBytes < bytes(CUT_NOTE)) {
        budgetReached = true;
        break;
      }
      opts.onStep?.({ type: 'tool', name: call.name, input: call.arguments });
      toolCalls++;
      // Workers AI's documented convention: the chosen call as the assistant turn, then its result.
      messages.push({ role: 'assistant', content: assistant });
      messages.push({ role: 'tool', content: fit(runAskTool(graph, call.name, call.arguments),
        Math.min(FREE_ASK_LIMITS.maxMessageChars, roomChars), roomBytes) });
    }
  }
}
