// The Ask loop: the model calls ASK_TOOLS against one project until it answers.
// Works in the browser (bring-your-own-key) and in Node (pre-generated demo tours).
import Anthropic from '@anthropic-ai/sdk';
import type { StudioProject } from '@rea-studio/schema';
import { indexGraph, type ProjectGraph } from './graph.js';
import { ASK_SYSTEM_PROMPT, STEP_LIMIT_NOTE } from './prompt.js';
import { ASK_TOOLS, runAskTool } from './tools.js';

export const ASK_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'best answers' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'faster, about half the price' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'fastest and cheapest' },
] as const;
export type AskModel = (typeof ASK_MODELS)[number]['id'];
export const DEFAULT_ASK_MODEL: AskModel = 'claude-opus-5-5';

/** Server-side refusal fallback (`fallbacks: "default"`) is available on these models. */
const FALLBACK_MODELS: ReadonlySet<AskModel> = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

export type AskStep =
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'answering' };

export interface AskUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AskResult {
  /** Markdown; node references are links to `node:<id>`. */
  answer: string;
  /** Ids linked in the answer that exist in the project, in order of first mention. */
  citedNodeIds: string[];
  toolCalls: number;
  /** The model that produced the final message (differs if a refusal fallback ran). */
  model: string;
  stopReason: string | null;
  usage: AskUsage;
}

export interface AskOptions {
  client: Anthropic;
  project: StudioProject | ProjectGraph;
  question: string;
  model?: AskModel;
  /** Tool-using rounds before the model must answer. */
  maxToolRounds?: number;
  signal?: AbortSignal;
  onStep?: (step: AskStep) => void;
}

export class AskDeclinedError extends Error {
  override name = 'AskDeclinedError';
}

const NODE_LINK = /\]\(node:([^)\s]+)\)/g;

/** Node ids linked from an answer, kept only if they exist in the project. */
export function citedNodeIds(answer: string, graph: ProjectGraph): string[] {
  const ids: string[] = [];
  for (const m of answer.matchAll(NODE_LINK)) {
    const id = m[1];
    if (id && graph.byId.has(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export async function askProject(opts: AskOptions): Promise<AskResult> {
  const graph = 'byId' in opts.project ? opts.project : indexGraph(opts.project);
  const model = opts.model ?? DEFAULT_ASK_MODEL;
  const maxRounds = opts.maxToolRounds ?? 8;
  const usage: AskUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: opts.question }];
  let toolCalls = 0;

  for (let round = 0; ; round++) {
    const lastRound = round >= maxRounds;
    if (lastRound) messages.push({ role: 'system', content: STEP_LIMIT_NOTE });
    const response = await opts.client.beta.messages.create(
      {
        model,
        max_tokens: 16000,
        system: ASK_SYSTEM_PROMPT,
        tools: ASK_TOOLS,
        messages,
        // Caches tools + system + conversation so far; each round re-reads the growing prefix.
        cache_control: { type: 'ephemeral' },
        output_config: { effort: 'medium' },
        ...(lastRound ? { tool_choice: { type: 'none' as const } } : {}),
        ...(FALLBACK_MODELS.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      },
      { signal: opts.signal },
    );
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;

    if (response.stop_reason === 'refusal') {
      throw new AskDeclinedError(response.stop_details?.explanation ?? 'The model declined to answer this question.');
    }

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (response.stop_reason === 'tool_use' && toolUses.length > 0 && !lastRound) {
      messages.push({ role: 'assistant', content: response.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((t) => {
        opts.onStep?.({ type: 'tool', name: t.name, input: t.input });
        toolCalls++;
        return { type: 'tool_result', tool_use_id: t.id, content: runAskTool(graph, t.name, t.input) };
      });
      messages.push({ role: 'user', content: results });
      continue;
    }

    opts.onStep?.({ type: 'answering' });
    const answer = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return { answer, citedNodeIds: citedNodeIds(answer, graph), toolCalls, model: response.model, stopReason: response.stop_reason, usage };
  }
}

/** A short, user-facing explanation for a failed ask. */
export function describeAskError(error: unknown): string {
  if (error instanceof AskDeclinedError) return error.message;
  if (error instanceof Anthropic.AuthenticationError) return 'That API key was rejected. Check it and try again.';
  if (error instanceof Anthropic.PermissionDeniedError) return 'This API key isn’t allowed to use that model.';
  if (error instanceof Anthropic.RateLimitError) return 'Rate limited by the API. Wait a moment and try again.';
  if (error instanceof Anthropic.BadRequestError) return `The API rejected the request: ${error.message}`;
  if (error instanceof Anthropic.APIConnectionError) return 'Couldn’t reach the Anthropic API (network or browser blocked the request).';
  if (error instanceof Anthropic.APIError) return `API error ${error.status ?? ''}: ${error.message}`;
  if (error instanceof Error && error.name === 'AbortError') return 'Stopped.';
  return error instanceof Error ? error.message : String(error);
}
