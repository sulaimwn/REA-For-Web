// T008: merging per-file REA runs into a whole-app run whose shared budget dropped them.
// Base: the committed GitHub Desktop fixture (139 of 179 files lost their relationships).
// Runs: main.js and crash.js analyzed on their own (fixtures/tools/isolate-files.mjs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { StudioProject } from '@rea-studio/schema';
import { adaptReaResult, recoverDroppedRelationships } from '../src/index.js';

const samples = new URL('../../../../fixtures/samples/', import.meta.url);
const load = (name: string): StudioProject =>
  adaptReaResult(JSON.parse(readFileSync(new URL(name, samples), 'utf8')), { reaVersion: '6.4.0' }).project;
const base = load('github-desktop-3.6.5.trimmed.rea-6.4.0.json');
const runs = [
  { path: 'main.js', project: load('github-desktop-3.6.5.isolated.main.js.rea-6.4.0.json') },
  { path: 'crash.js', project: load('github-desktop-3.6.5.isolated.crash.js.rea-6.4.0.json') },
];
const { project, report } = recoverDroppedRelationships(base, runs);

const fileNode = (p: StudioProject, path: string) => p.nodes.find((n) => n.kind === 'file' && n.path === path);
const outgoing = (p: StudioProject, path: string, relation: string) => {
  const f = fileNode(p, path);
  return p.edges.filter((e) => e.source === f?.id && e.relation === relation);
};

describe('recovering relationships REA dropped (T008)', () => {
  it('starts from a whole-app run where both files lost their relationships', () => {
    const main = fileNode(base, 'main.js');
    assert.ok(main?.kind === 'file' && main.analysisIssue !== null);
    assert.equal(outgoing(base, 'main.js', 'imports').length, 0);
    assert.equal(outgoing(base, 'crash.js', 'sends').length, 0);
  });

  it('brings back main.js imports and storage, and crash.js IPC', () => {
    assert.deepEqual(report.recoveredFiles, ['main.js', 'crash.js']);
    assert.equal(outgoing(project, 'main.js', 'imports').length, 19);
    assert.equal(outgoing(project, 'main.js', 'persists_to').length, 1);
    assert.equal(outgoing(project, 'crash.js', 'imports').length, 7);
    assert.equal(outgoing(project, 'crash.js', 'sends').length, 1);
    assert.equal(outgoing(project, 'crash.js', 'invokes').length, 1);
    const handler = project.edges.find((e) => e.relation === 'contains' && e.source === fileNode(project, 'crash.js')?.id && project.nodes.find((n) => n.id === e.target)?.kind === 'ipc-handler');
    assert.ok(handler, 'crash.js contains its IPC handler');
  });

  it('marks the files recovered, explains it, and rebuilds the findings', () => {
    const main = fileNode(project, 'main.js');
    assert.equal(main?.kind === 'file' && main.analysisIssue, null);
    assert.equal(project.analysis.filesWithAnalysisIssues, base.analysis.filesWithAnalysisIssues - 2);
    assert.ok(project.analysis.limitations.some((l) => l.startsWith('2 files lost their relationships')));
    const count = (p: StudioProject, c: string) => p.findings.find((f) => f.category === c)?.count ?? 0;
    assert.ok(count(project, 'imports') > count(base, 'imports'));
    assert.ok(count(project, 'ipc') > count(base, 'ipc'));
  });

  it('merges shared things instead of duplicating them, with no dangling links', () => {
    const ids = new Set(project.nodes.map((n) => n.id));
    assert.equal(ids.size, project.nodes.length, 'unique node ids');
    assert.equal(new Set(project.edges.map((e) => e.id)).size, project.edges.length, 'unique edge ids');
    for (const e of project.edges) assert.ok(ids.has(e.source) && ids.has(e.target), e.id);
    // `electron` is imported by both runs and the base: still one node, now with more import sites.
    const electron = project.nodes.filter((n) => n.kind === 'external-module' && n.specifier === 'electron');
    assert.equal(electron.length, 1);
    assert.ok(report.mergedNodes > 0);
  });

  it('is idempotent and leaves the input project unchanged', () => {
    const again = recoverDroppedRelationships(project, runs);
    assert.equal(again.report.addedNodes, 0);
    assert.equal(again.report.addedEdges, 0);
    assert.equal(outgoing(base, 'main.js', 'imports').length, 0, 'input not mutated');
  });

  it('skips runs for files the app does not have', () => {
    const r = recoverDroppedRelationships(base, [{ path: 'nope.js', project: runs[0]!.project }]);
    assert.deepEqual(r.report.skipped, [{ path: 'nope.js', reason: 'not a file of this app' }]);
    assert.equal(r.project.edges.length, base.edges.length);
  });
});

describe('relative imports in a file analyzed alone', () => {
  // A hand-written app: src/main/main.js requires './notes-store'. Alone, REA can't resolve it.
  const tiny = load('tiny-electron.rea-6.4.0.json');
  const isolated = structuredClone(tiny);
  const main = isolated.nodes.find((n) => n.kind === 'file' && n.path === 'src/main/main.js');
  isolated.nodes.push({ id: 'iso:./notes-store', kind: 'external-module', label: './notes-store', specifier: './notes-store', resolution: 'not-found', evidence: [], origin: { source: 'rea' } });
  isolated.edges.push({ id: 'iso:import', source: main!.id, target: 'iso:./notes-store', relation: 'imports', evidence: main!.evidence[0]!, origin: { source: 'rea' }, details: {} });

  it('links it to the app file it names instead of adding a false "not found" module', () => {
    const { project, report } = recoverDroppedRelationships(tiny, [{ path: 'src/main/main.js', project: isolated }]);
    assert.equal(report.resolvedRelativeImports, 1);
    assert.ok(!project.nodes.some((n) => n.id === 'iso:./notes-store'));
    const store = project.nodes.find((n) => n.kind === 'file' && n.path === 'src/main/notes-store.js');
    const mainId = project.nodes.find((n) => n.kind === 'file' && n.path === 'src/main/main.js')?.id;
    assert.ok(project.edges.some((e) => e.source === mainId && e.target === store?.id && e.relation === 'imports'));
  });
});
