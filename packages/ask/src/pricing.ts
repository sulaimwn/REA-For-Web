import type { AskUsage } from './agent.js';

// Standard API rates checked 2026-10-12 (USD / million tokens):
// https://platform.claude.com/docs/en/about-claude/pricing
// Automatic caching uses five-minute writes. This is an estimate, not a bill.
const RATES: Record<string, readonly [input: number, output: number, cacheRead: number]> = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.1],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
};

/** Price each response using its actual model and prompt length, including fallbacks. */
export function estimateResponseCost(model: string, usage: AskUsage): number | null {
  const id = Object.keys(RATES).find((key) => model === key || model.startsWith(`${key}-`));
  if (!id) return null;
  let [input, output, read] = RATES[id]!;
  if (id === 'claude-haiku-5-5' && usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 100_000) {
    [input, output, read] = [0.5, 2.5, 0.05];
  }
  return (usage.inputTokens * input + usage.outputTokens * output +
    usage.cacheReadTokens * read + usage.cacheWriteTokens * input * 1.25) / 1e6;
}
