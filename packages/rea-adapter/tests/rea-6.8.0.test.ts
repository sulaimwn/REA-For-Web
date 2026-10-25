// Fresh 6.8 Evidence, never historical records patched to satisfy a newer validator.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { adaptReaResult } from '../src/index.js';

const samples = new URL('../../../../fixtures/samples/', import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(name, samples), 'utf8'));

describe('REA 6.8.0 real producer compatibility', () => {
  it('keeps the Electron answer-key connections without false gaps or dangling links', () => {
    const raw = load('tiny-electron.asar.rea-6.8.0.json');
    assert.equal(raw.relationship_coverage, null, '6.8 emits the explicit nullable commitment');
    assert.deepEqual(raw.normalized_result.integrity_contradictions, []);
    const { project, report } = adaptReaResult(raw, { reaVersion: '6.8.0' });
    assert.equal(project.target.format, 'asar');
    assert.equal(project.target.sha256, '6cdb3d8bdb43dbd18af75a646c0b5d7e9102b69c4b7f176fe9a76cba18a1c2d2');
    assert.equal(project.analysis.coverage.status, 'complete');
    assert.equal(project.nodes.filter(n => n.kind === 'analysis-gap').length, 0);
    assert.deepEqual(report.unrecognizedNodeKinds, {});
    assert.equal(report.droppedEdgesDanglingEndpoint, 0);
    const byId = new Map(project.nodes.map(n => [n.id, n]));
    const paths = project.edges.filter(e => e.id.startsWith('call-path:')).map(e => {
      assert.equal(byId.get(e.source)?.kind, 'bridge-api');
      assert.equal(e.origin.source, 'rea');
      assert.equal(e.evidence.state, 'inferred');
      const channel = byId.get(e.target);
      assert.equal(channel?.kind, 'ipc-channel');
      return `${e.relation} ${channel?.kind === 'ipc-channel' ? channel.channel : '?'}`;
    }).sort();
    assert.deepEqual(paths, ['invokes notes:list', 'invokes notes:save', 'sends app:quit']);
    assert.ok(project.edges.every(e => byId.has(e.source) && byId.has(e.target)));
  });

  it('projects fresh managed Evidence and retains known types, methods and native imports', () => {
    const raw = load('tiny-dotnet.rea-6.8.0.json');
    for (const envelope of Object.values(raw) as Record<string, unknown>[]) {
      assert.ok(Object.hasOwn(envelope, 'relationship_coverage'));
    }
    const { project } = adaptReaResult(raw, { reaVersion: '6.8.0' });
    assert.equal(project.target.appKind, 'dotnet');
    assert.equal(project.target.sha256, '3b6d2e9f4dc01e65a828dd455533ee5a1dfac47f0427ca8eb77b86e5e0cf528b');
    assert.equal(project.nodes.filter(n => n.kind === 'managed-type').length, 6);
    assert.equal(project.nodes.filter(n => n.kind === 'managed-method').length, 10);
    assert.equal(project.nodes.filter(n => n.kind === 'native-import').length, 3);
    assert.equal(project.analysis.coverage.status, 'partial');
    assert.ok(project.analysis.limitations.some(l => l.includes('generic method-instantiation')));
    assert.ok(project.edges.some(e => e.relation === 'calls'));
    assert.equal(new Set(project.edges.map(e => `${e.source}|${e.relation}|${e.target}`)).size, project.edges.length);
    const projected = raw.project_managed_application_graph.normalized_result.graph.edges.filter((e: { relation: string }) => e.relation === 'calls');
    assert.equal(projected.length, 8);
    for (const e of projected) {
      const call = project.edges.find(c => c.id === e.edge_id);
      assert.ok(call);
      assert.equal(call.details.callSites, 1);
      assert.equal(call.evidence.extractor, 'inspect_managed_members');
    }
  });

  it('keeps projected calls and their site counts without the optional member inspection', () => {
    const raw = load('tiny-dotnet.rea-6.8.0.json');
    delete raw.inspect_managed_members;
    const { project } = adaptReaResult(raw, {reaVersion:'6.8.0'});
    const calls = project.edges.filter(e=>e.relation==='calls');
    assert.equal(calls.length,8);
    assert.ok(calls.every(e=>e.details.callSites===1));
    assert.ok(project.analysis.limitations.some(l=>l.includes('only projected calls')));
  });

  it('does not add matching CIL sites to projected counts and still counts external call sites', () => {
    const raw = load('tiny-dotnet.rea-6.8.0.json');
    const rows = raw.inspect_managed_members.normalized_result.call_edges;
    const row = rows.find((c: {target_kind:string})=>c.target_kind==='method-def');
    assert.ok(row);
    rows.push(structuredClone(row));
    const external = rows.find((c: {target_kind:string})=>c.target_kind==='member-ref');
    rows.push(structuredClone(external));
    const graph = raw.project_managed_application_graph.normalized_result.graph;
    const original = graph.edges.find((e:{relation:string})=>e.relation==='calls');
    original.properties.site_count=7;
    original.properties.opcodes={newobj:7};
    const {project} = adaptReaResult(raw,{reaVersion:'6.8.0'});
    assert.ok(project.edges.some(e=>e.id.startsWith('managed-call:') && e.details.callSites===2));
    assert.equal(project.edges.find(e=>e.id===original.edge_id)?.details.callSites,7);
  });

  it('continues viewing historical Evidence without modifying its identity or coverage fields', () => {
    const raw = load('tiny-electron.rea-6.5.0.json');
    const before = JSON.stringify(raw);
    const { project } = adaptReaResult(raw, { reaVersion: '6.5.0' });
    assert.equal(project.analysis.engine.version, '6.5.0');
    assert.equal(project.analysis.reaEvidenceId, raw.evidence_id);
    assert.equal(JSON.stringify(raw), before);
  });
});
