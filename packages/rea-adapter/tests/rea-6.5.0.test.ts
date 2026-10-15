// REA 6.5.0 compatibility (T061), on real output for the tiny Electron sample.
// 6.5.0 adds Electron call-path steps (bridge member → closure → ipcRenderer call) as
// `javascript-expression` nodes; they become bridge → channel edges, not analysis gaps.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { adaptReaResult } from '../src/index.js';
import type { ReaNode, ReaResult } from '../src/rea-types.js';

const samples = new URL('../../../../fixtures/samples/', import.meta.url);
const load = (file: string, reaVersion: string) =>
  adaptReaResult(JSON.parse(readFileSync(new URL(file, samples), 'utf8')), { reaVersion });
const raw65 = () => JSON.parse(readFileSync(new URL('tiny-electron.rea-6.5.0.json', samples), 'utf8')) as ReaResult;
const links = (raw: ReaResult) => adaptReaResult(raw, { reaVersion: '6.5.0' });
const pathEdges = (result: ReturnType<typeof links>) => result.project.edges.filter(e => e.id.startsWith('call-path:'));

// Preserve the real producer shapes while varying artifact/source identity.
function otherArtifact(node: ReaNode): ReaNode {
  const copy = structuredClone(node);
  copy.node_id += ':other';
  copy.identity!.artifact_sha256 = 'a'.repeat(64);
  for (const o of copy.observations ?? []) {
    o.evidence!.artifact!.sha256 = 'a'.repeat(64);
    o.evidence!.location!.value!.source = 'src/other-preload.js';
  }
  return copy;
}

describe('REA 6.5.0 tiny Electron sample', () => {
  const v65 = load('tiny-electron.rea-6.5.0.json', '6.5.0');
  const v64 = load('tiny-electron.rea-6.4.0.json', '6.4.0');

  it('keeps the same parts as 6.4.0: call-path steps are not drawn as analysis gaps', () => {
    assert.equal(v65.project.nodes.filter((n) => n.kind === 'analysis-gap').length, 0);
    assert.deepEqual(v65.report.unrecognizedNodeKinds, {});
    assert.deepEqual(
      v65.project.nodes.map((n) => n.kind).sort(),
      v64.project.nodes.map((n) => n.kind).sort(),
    );
    assert.equal(v65.report.foldedCallPathSteps, 9);
    assert.equal(v65.report.droppedEdgesDanglingEndpoint, 0);
    assert.deepEqual(v65.project.findings.map((f) => [f.category, f.count]), v64.project.findings.map((f) => [f.category, f.count]));
  });

  it('links window.notesApi to the channels its members call, as REA-inferred edges', () => {
    const byId = new Map(v65.project.nodes.map((n) => [n.id, n]));
    const links = v65.project.edges
      .filter((e) => e.id.startsWith('call-path:'))
      .map((e) => {
        const source = byId.get(e.source);
        const target = byId.get(e.target);
        assert.equal(source?.kind, 'bridge-api');
        assert.equal(target?.kind, 'ipc-channel');
        assert.equal(e.origin.source, 'rea');
        assert.equal(e.evidence.state, 'inferred');
        return `${e.relation} ${target?.kind === 'ipc-channel' ? target.channel : '?'} ${e.details.operation}`;
      })
      .sort();
    assert.deepEqual(links, ['invokes notes:list invoke', 'invokes notes:save invoke', 'sends app:quit send']);
    assert.deepEqual(v65.report.callPathLinks, { linked: 3, unlinked: 0 });
    // 6.4.0 had no such paths.
    assert.equal(v64.project.edges.filter((e) => e.id.startsWith('call-path:')).length, 0);
  });

  it('selects the bridge from the path artifact/exposure rather than the first matching API name', () => {
    const raw = raw65();
    const bridge = raw.normalized_result.graph.nodes.find(n => n.kind === 'context-bridge-api')!;
    raw.normalized_result.graph.nodes.unshift(otherArtifact(bridge));
    const result = links(raw);
    assert.equal(pathEdges(result).length, 3);
    assert.ok(pathEdges(result).every(e => e.source === bridge.node_id));
    assert.deepEqual(result.report.callPathLinks, { linked: 3, unlinked: 0 });
  });

  it('keeps identical path hashes from different artifacts distinct', () => {
    const raw = raw65();
    const graph = raw.normalized_result.graph;
    const copies = graph.nodes.filter(n => n.kind === 'context-bridge-api'
      || n.identity?.namespace === 'electron-call-path-step').map(otherArtifact);
    graph.nodes.push(...copies);
    const result = links(raw);
    const edges = pathEdges(result);
    assert.equal(edges.length, 6);
    assert.equal(new Set(edges.map(e => e.id)).size, 6);
    assert.equal(new Set(edges.map(e => e.source)).size, 2);
    assert.deepEqual(result.report.callPathLinks, { linked: 6, unlinked: 0 });
  });

  it('refuses ambiguous bridge identity instead of guessing', () => {
    const raw = raw65();
    const bridge = structuredClone(raw.normalized_result.graph.nodes.find(n => n.kind === 'context-bridge-api')!);
    bridge.node_id += ':ambiguous';
    raw.normalized_result.graph.nodes.push(bridge);
    const result = links(raw);
    assert.equal(pathEdges(result).length, 0);
    assert.deepEqual(result.report.callPathLinks, { linked: 0, unlinked: 3 });
  });

  it('does not infer a bridge when the exposure location is unavailable', () => {
    const raw = raw65();
    for (const n of raw.normalized_result.graph.nodes) {
      if (n.identity?.namespace !== 'electron-call-path-step') continue;
      for (const o of n.observations ?? []) {
        if (o.properties?.step_kind === 'exposure') o.evidence!.location = { available: false, value: null };
      }
    }
    const result = links(raw);
    assert.equal(pathEdges(result).length, 0);
    assert.deepEqual(result.report.callPathLinks, { linked: 0, unlinked: 3 });
  });
});
