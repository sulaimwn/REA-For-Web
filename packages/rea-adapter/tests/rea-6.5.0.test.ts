// REA 6.5.0 compatibility (T061), on real output for the tiny Electron sample.
// 6.5.0 adds Electron call-path steps (bridge member → closure → ipcRenderer call) as
// `javascript-expression` nodes; they become bridge → channel edges, not analysis gaps.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { adaptReaResult } from '../src/index.js';

const samples = new URL('../../../../fixtures/samples/', import.meta.url);
const load = (file: string, reaVersion: string) =>
  adaptReaResult(JSON.parse(readFileSync(new URL(file, samples), 'utf8')), { reaVersion });

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
});
