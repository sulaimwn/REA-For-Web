// T045: big programs' overview is a call tree from the entry point, built on real REA evidence (jq 1.8.2).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { adaptReaResult } from '@rea-studio/rea-adapter';
import { entryTree, isEntryNode } from '../lib/entry-tree.ts';

const samples = new URL('../../../fixtures/samples/', import.meta.url);
const load = (file) => adaptReaResult(JSON.parse(readFileSync(new URL(file, samples), 'utf8')), { reaVersion: '6.4.0' }).project;
const outgoingOf = (project) => {
  const out = new Map();
  for (const e of project.edges) out.set(e.source, [...(out.get(e.source) ?? []), e]);
  return out;
};

describe('entry tree (T045)', () => {
  const jq = load('jq-1.8.2-windows.rea-6.4.0.json');
  const outgoing = outgoingOf(jq);
  const candidates = new Set(jq.nodes.filter((n) => n.kind === 'native-function' || n.kind === 'native-import').map((n) => n.id));

  it('draws a connected tree of at most the limit, starting at the program’s entry', () => {
    assert.ok(candidates.size > 1_000);
    const tree = entryTree(jq.nodes, outgoing, candidates, 100);
    assert.ok(tree);
    assert.equal(tree.ids.size, 100);
    const byId = new Map(jq.nodes.map((n) => [n.id, n]));
    assert.deepEqual(tree.roots.map((id) => byId.get(id).name), ['entry']);
    // Every drawn non-root part is called by another drawn part: no scattered islands.
    for (const id of tree.ids) {
      if (tree.roots.includes(id)) continue;
      assert.ok(jq.edges.some((e) => e.target === id && e.relation !== 'contains' && tree.ids.has(e.source)), id);
    }
    // It reaches past the entry's own callees.
    const firstLevel = new Set((outgoing.get(tree.roots[0]) ?? []).map((e) => e.target));
    assert.ok([...tree.ids].some((id) => id !== tree.roots[0] && !firstLevel.has(id)));
  });

  it('gives up (null) without an entry point, so the overview keeps its old fallback', () => {
    const noEntry = new Set([...candidates].filter((id) => !isEntryNode(jq.nodes.find((n) => n.id === id))));
    assert.equal(entryTree(jq.nodes, outgoing, noEntry, 100), null);
  });

  it('recognizes .NET entry methods, C main symbols and Android launchers', () => {
    const dotnet = load('tiny-dotnet.rea-6.4.0.json');
    assert.deepEqual(dotnet.nodes.filter(isEntryNode).map((n) => n.name), ['Main']);
    const fn = (name) => ({ kind: 'native-function', name, entryPoint: false });
    assert.deepEqual(['main', '_main', 'wmain', 'mainloop', 'FUN_1400016a0'].map((name) => isEntryNode(fn(name))), [true, true, true, false, false]);
    assert.equal(isEntryNode({ kind: 'android-component', launcher: true }), true);
  });
});
