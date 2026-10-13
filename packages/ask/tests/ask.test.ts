import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { toStudioProject } from '@rea-studio/rea-adapter';
import { AskDeclinedError, askProject, indexGraph, runAskTool, type AskStep } from '../src/index.js';

const samples = new URL('../../../../fixtures/samples/', import.meta.url);
const project = (file: string) => toStudioProject(JSON.parse(readFileSync(new URL(file, samples), 'utf8')), { reaVersion: '6.4.0' });
const tiny = indexGraph(project('tiny-electron.rea-6.4.0.json'));
const ghd = indexGraph(project('github-desktop-3.6.5.trimmed.rea-6.4.0.json'));
const call = (g: typeof tiny, name: string, input: unknown = {}) => JSON.parse(runAskTool(g, name, input));
const idOf = (g: typeof tiny, query: string, kind: string) => call(g, 'search_nodes', { query, kind }).matches[0]?.id as string;

describe('ask tools', () => {
  it('project_overview summarizes the app and its findings', () => {
    const o = call(tiny, 'project_overview');
    assert.equal(o.app.name, 'tiny-electron');
    assert.equal(o.analysis.coverage, 'complete');
    assert.equal(o.findings.find((f: { category: string }) => f.category === 'ipc').count, 3);
    assert.equal(o.nodeCounts['ipc-channel'], 3);
  });

  it('search_nodes matches every word, filters by kind, and ranks exact names first', () => {
    const r = call(tiny, 'search_nodes', { query: 'notes:save', kind: 'ipc-channel' });
    assert.equal(r.total, 1);
    assert.equal(r.matches[0].name, 'notes:save');
    assert.ok(call(ghd, 'search_nodes', { query: 'zoom', kind: 'storage' }).matches.some((m: { name: string }) => m.name === 'zoom-factor'));
    assert.equal(call(tiny, 'search_nodes', { query: 'notes save nonexistent', kind: 'any' }).total, 0);
  });

  it('get_node returns facts and located evidence', () => {
    const n = call(tiny, 'get_node', { id: idOf(tiny, 'notes:save', 'ipc-channel') });
    assert.equal(n.facts.resolution, 'literal');
    assert.equal(n.origin, 'rea');
    assert.deepEqual(n.evidence.items.map((e: { at: string }) => e.at).sort(), ['src/main/main.js:17:0', 'src/preload.js:4:18']);
  });

  it('get_neighbors follows IPC links with their evidence', () => {
    const preloadFile = tiny.project.nodes.find((n) => n.kind === 'file' && n.path === 'src/preload.js');
    assert.ok(preloadFile);
    const r = call(tiny, 'get_neighbors', { id: preloadFile.id, direction: 'out' });
    const invokes = r.links.items.filter((l: { relation: string; other: { kind: string } }) => l.relation === 'invokes' && l.other.kind === 'ipc-channel');
    assert.deepEqual(invokes.map((l: { other: { name: string } }) => l.other.name).sort(), ['notes:list', 'notes:save']);
  });

  it('find_path traces preload → channel → handler without going through the artifact root', () => {
    const from = tiny.project.nodes.find((n) => n.kind === 'file' && n.path === 'src/preload.js')?.id;
    const to = idOf(tiny, 'handle notes:save', 'ipc-handler');
    const r = call(tiny, 'find_path', { from_id: from, to_id: to });
    assert.equal(r.found, true);
    assert.ok(r.hops <= 3, `short path, got ${r.hops}`);
    assert.ok(r.steps.every((s: { other: { name: string } }) => s.other.name !== 'artifact root'));
  });

  it('reports bad ids and unknown tools as errors instead of throwing', () => {
    assert.match(call(tiny, 'get_node', { id: 'nope' }).error, /No node/);
    assert.match(call(tiny, 'teleport').error, /Unknown tool/);
  });
});

/** A stand-in for the Anthropic client that replays scripted responses and records requests. */
function fakeClient(responses: Partial<Anthropic.Beta.BetaMessage>[]) {
  const requests: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 };
  const client = {
    beta: {
      messages: {
        create: async (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
          requests.push(structuredClone(params));
          const next = responses.shift();
          assert.ok(next, 'unexpected extra request');
          return { model: params.model, usage, stop_details: null, ...next };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input }) as Anthropic.Beta.BetaToolUseBlock;
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as Anthropic.Beta.BetaTextBlock;

describe('askProject loop', () => {
  it('runs tools, feeds results back, and returns the answer with validated citations', async () => {
    const saveId = idOf(tiny, 'notes:save', 'ipc-channel');
    const { client, requests } = fakeClient([
      { stop_reason: 'tool_use', content: [toolUse('t1', 'search_nodes', { query: 'notes:save', kind: 'ipc-channel' })] },
      { stop_reason: 'end_turn', content: [text(`It goes through [notes:save](node:${saveId}) and [ghost](node:not-a-real-id).`)] },
    ]);
    const steps: AskStep[] = [];
    const r = await askProject({ client, project: tiny, question: 'How are notes saved?', onStep: (s) => steps.push(s) });

    assert.deepEqual(r.citedNodeIds, [saveId], 'unknown ids are dropped');
    assert.equal(r.toolCalls, 1);
    assert.deepEqual(r.usage, { inputTokens: 200, outputTokens: 40, cacheReadTokens: 100, cacheWriteTokens: 0 });
    assert.deepEqual(steps.map((s) => s.type), ['tool', 'answering']);

    const second = requests[1];
    assert.ok(second);
    const toolResultTurn = second.messages[2];
    assert.equal(toolResultTurn?.role, 'user');
    const block = (toolResultTurn?.content as Anthropic.Beta.BetaToolResultBlockParam[])[0];
    assert.equal(block?.tool_use_id, 't1');
    assert.equal(JSON.parse(block?.content as string).matches[0].id, saveId);
  });

  it('forces an answer at the tool-round limit', async () => {
    const { client, requests } = fakeClient([
      { stop_reason: 'tool_use', content: [toolUse('t1', 'project_overview', {})] },
      { stop_reason: 'end_turn', content: [text('Best effort answer.')] },
    ]);
    const r = await askProject({ client, project: tiny, question: 'Everything?', maxToolRounds: 1 });
    assert.equal(r.answer, 'Best effort answer.');
    const last = requests[1];
    assert.deepEqual(last?.tool_choice, { type: 'none' });
    assert.equal(last?.messages.at(-1)?.role, 'system');
  });

  it('caches the prefix, sets effort, and opts into refusal fallback only where supported', async () => {
    for (const [model, expectFallback] of [['claude-opus-5-5', true], ['claude-haiku-5-5', false]] as const) {
      const { client, requests } = fakeClient([{ stop_reason: 'end_turn', content: [text('ok')] }]);
      await askProject({ client, project: tiny, question: 'q', model });
      const req = requests[0];
      assert.deepEqual(req?.cache_control, { type: 'ephemeral' });
      assert.equal(req?.output_config?.effort, 'medium');
      assert.equal(req?.fallbacks === 'default', expectFallback, model);
    }
  });

  it('turns a refusal into AskDeclinedError', async () => {
    const { client } = fakeClient([{ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category: null, explanation: 'Declined.' } as Anthropic.Beta.BetaRefusalStopDetails }]);
    await assert.rejects(askProject({ client, project: tiny, question: 'q' }), AskDeclinedError);
  });
});
