import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  CONFIDENCE_LEVELS,
  EVIDENCE_STATES,
  FINDING_CATEGORIES,
  NODE_KINDS,
  RELATIONS,
  STUDIO_SCHEMA_VERSION,
  type StudioNode,
  type StudioProject,
} from '@rea-studio/schema';
import { adaptReaResult, ReaOutputError, toStudioProject } from '../src/index.js';
import type { ReaResult } from '../src/rea-types.js';

// Compiled to dist-tests/tests/, so the repo root is four levels up.
const samples = new URL('../../../../fixtures/samples/', import.meta.url);
const load = (name: string): unknown => JSON.parse(readFileSync(new URL(name, samples), 'utf8'));
const TINY = 'tiny-electron.rea-6.4.0.json';
const GHD = 'github-desktop-3.6.5.trimmed.rea-6.4.0.json';
const opts = { reaVersion: '6.4.0' };

describe('retained REA timeout Evidence', () => {
  const raw = load('tiny-electron.timeout.rea-6.4.0.json') as {
    code: string;
    details: {
      cleanup?: string;
      partial_observation: {
        subject: { digest: { sha256?: string } };
        normalized_result: { graph: { coverage: { status: string } } };
      };
    };
  };
  const partialOpts = { ...opts, retainedTimeoutEvidence: 'require' as const };
  it('requires opt-in and preserves the exact partial facts and coverage', () => {
    assert.throws(() => adaptReaResult(raw, opts), ReaOutputError);
    const result = adaptReaResult(raw, partialOpts);
    assert.equal(result.project.analysis.coverage.status, 'partial');
    assert.deepEqual(result, adaptReaResult(raw.details.partial_observation, opts));
    assertInvariants(result.project);
    assert.ok(result.project.nodes.some(n => n.kind === 'analysis-gap'));
  });
  it('rejects cleanup failures and non-timeout error envelopes', () => {
    const cleanup = structuredClone(raw);
    cleanup.details.cleanup = 'incomplete';
    assert.throws(() => adaptReaResult(cleanup, partialOpts), ReaOutputError);
    for (const code of ['cleanup_incomplete', 'cancelled', 'invalid_request']) {
      assert.throws(() => adaptReaResult({ ...raw, code }, partialOpts), ReaOutputError);
    }
    assert.throws(() => adaptReaResult(load(TINY), partialOpts), ReaOutputError);
  });
  it('rejects missing, malformed, or falsely complete retained Evidence', () => {
    assert.throws(() => adaptReaResult({ ...raw, details: {} }, partialOpts), ReaOutputError);
    const complete = structuredClone(raw);
    complete.details.partial_observation.normalized_result.graph.coverage.status = 'complete';
    assert.throws(() => adaptReaResult(complete, partialOpts), ReaOutputError);
    const malformed = structuredClone(raw);
    delete malformed.details.partial_observation.subject.digest.sha256;
    assert.throws(() => adaptReaResult(malformed, partialOpts), ReaOutputError);
  });
});

const ofKind = <K extends StudioNode['kind']>(p: StudioProject, kind: K) =>
  p.nodes.filter((n): n is Extract<StudioNode, { kind: K }> => n.kind === kind);
const finding = (p: StudioProject, category: string) => {
  const f = p.findings.find((x) => x.category === category);
  assert.ok(f, `missing finding ${category}`);
  return f;
};
// Raw REA node counts, for comparing against adapter output.
const reaKindCount = (raw: unknown, kind: string) =>
  (raw as { normalized_result: { graph: { nodes: { kind: string }[] } } }).normalized_result.graph.nodes.filter((n) => n.kind === kind).length;

function assertInvariants(p: StudioProject) {
  assert.equal(p.schemaVersion, STUDIO_SCHEMA_VERSION);
  assert.equal(p.id, p.target.sha256);
  assert.match(p.target.sha256, /^[0-9a-f]{64}$/);

  const ids = new Set(p.nodes.map((n) => n.id));
  assert.equal(ids.size, p.nodes.length, 'node ids are unique');
  for (const e of p.edges) {
    assert.ok(ids.has(e.source) && ids.has(e.target), `edge ${e.id} endpoints exist`);
    assert.ok((RELATIONS as readonly string[]).includes(e.relation));
  }
  const allEvidence = [...p.nodes.flatMap((n) => n.evidence), ...p.edges.map((e) => e.evidence)];
  for (const ev of allEvidence) {
    assert.ok((CONFIDENCE_LEVELS as readonly string[]).includes(ev.confidence));
    assert.ok((EVIDENCE_STATES as readonly string[]).includes(ev.state));
  }
  for (const n of p.nodes) {
    assert.ok((NODE_KINDS as readonly string[]).includes(n.kind));
    assert.ok(n.evidence.length > 0, `node ${n.id} has evidence`);
    assert.deepEqual(n.origin, { source: 'rea' });
  }
  assert.deepEqual(p.findings.map((f) => f.category), [...FINDING_CATEGORIES]);
  for (const f of p.findings) {
    assert.notEqual(f.status, 'confirmed-absent', 'REA static analysis never proves absence');
    assert.equal(f.status === 'found', f.count > 0);
  }
  assert.deepEqual(p.analysis.omitted, ['semantic-graph', 'export-shape-nodes']);
}

describe('tiny-electron (hand-written ground truth)', () => {
  const { project: p, report } = adaptReaResult(load(TINY), opts);

  it('satisfies schema invariants', () => assertInvariants(p));

  it('identifies the app', () => {
    assert.deepEqual(
      { name: p.target.name, version: p.target.version, format: p.target.format, appKind: p.target.appKind },
      { name: 'tiny-electron', version: '1.0.0', format: 'directory', appKind: 'electron' },
    );
    assert.equal(p.analysis.engine.version, '6.4.0');
    assert.equal(p.analysis.coverage.status, 'complete');
  });

  it('finds main, preload, and renderer processes', () => {
    const roles = Object.fromEntries(ofKind(p, 'process').map((n) => [n.role, n.path]));
    assert.deepEqual(roles, { main: 'src/main/main.js', preload: 'src/preload.js', renderer: 'src/renderer/index.html' });
  });

  it('finds all three IPC channels, each used on both sides', () => {
    const channels = ofKind(p, 'ipc-channel').sort((a, b) => String(a.channel).localeCompare(String(b.channel)));
    assert.deepEqual(channels.map((c) => c.channel), ['app:quit', 'notes:list', 'notes:save']);
    for (const c of channels) {
      assert.equal(c.resolution, 'literal');
      assert.deepEqual(new Set(c.usages.map((u) => u.side)), new Set(['main', 'renderer']));
    }
    const ops = Object.fromEntries(channels.map((c) => [c.channel, c.usages.map((u) => u.operation).sort()]));
    assert.deepEqual(ops, { 'app:quit': ['on', 'send'], 'notes:list': ['handle', 'invoke'], 'notes:save': ['handle', 'invoke'] });
    assert.equal(ofKind(p, 'ipc-handler').length, 3);
    const ipc = finding(p, 'ipc');
    assert.equal(ipc.count, 3);
    assert.equal(ipc.unresolvedCount, 0);
    assert.equal(p.ipcSummary.pairedRendererTransmissions, 3);
  });

  it('keeps exact evidence locations', () => {
    const save = ofKind(p, 'ipc-channel').find((c) => c.channel === 'notes:save');
    const files = save?.evidence.map((e) => (e.location?.kind === 'source-range' ? `${e.location.file}:${e.location.start.line}` : null)).sort();
    assert.deepEqual(files, ['src/main/main.js:17', 'src/preload.js:4']);
  });

  it('finds the context bridge and the window that loads the preload', () => {
    const [bridge] = ofKind(p, 'bridge-api');
    assert.deepEqual({ apiKey: bridge?.apiKey, members: bridge?.members }, { apiKey: 'notesApi', members: ['list', 'quit', 'save'] });
    const [win] = ofKind(p, 'window');
    assert.equal(win?.preloadPath, '../preload.js');
    assert.deepEqual(win?.webPreferences.find((w) => w.name === 'contextIsolation')?.value, true);
  });

  it('keeps local import edges between modules', () => {
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    const imports = p.edges
      .filter((e) => e.relation === 'imports')
      .map((e) => [byId.get(e.source), byId.get(e.target)] as const)
      .filter(([s, t]) => s?.kind === 'module' && t?.kind === 'module')
      .map(([s, t]) => `${s?.kind === 'module' ? s.path : ''} -> ${t?.kind === 'module' ? t.path : ''}`);
    assert.ok(imports.includes('src/main/main.js -> src/main/notes-store.js'));
    assert.ok(imports.includes('src/renderer/renderer.js -> src/renderer/view.js'));
  });

  it('merges per-import-site external modules by specifier', () => {
    const ext = ofKind(p, 'external-module');
    assert.deepEqual(ext.map((e) => e.specifier).sort(), ['electron', 'fs', 'path']);
    const electron = ext.find((e) => e.specifier === 'electron');
    assert.equal(electron?.id, 'external-module:electron');
    assert.equal(electron?.evidence.length, 6);
    assert.equal(report.mergedExternalModuleNodes, 9);
  });

  it('drops export-shape nodes and their edges, and reports it', () => {
    assert.equal(report.droppedExportShapeNodes, 2);
    assert.equal(report.droppedEdgesToDroppedNodes, 2);
    assert.equal(report.droppedEdgesDanglingEndpoint, 0);
    assert.deepEqual(report.unrecognizedNodeKinds, {});
  });

  it('reports empty categories as not-found with a caveat, never absent', () => {
    for (const category of ['native-addons', 'endpoints', 'storage', 'workers', 'source-files']) {
      const f = finding(p, category);
      assert.equal(f.status, 'not-found');
      assert.match(f.notes[0] ?? '', /never proves absence/);
    }
  });
});

describe('GitHub Desktop 3.6.5 (trimmed real bundle)', () => {
  const raw = load(GHD);
  const p = toStudioProject(raw, opts);

  it('satisfies schema invariants', () => assertInvariants(p));

  it('identifies the app', () => {
    assert.deepEqual({ name: p.target.name, version: p.target.version, appKind: p.target.appKind }, { name: 'desktop', version: '3.6.5', appKind: 'electron' });
    assert.equal(p.analysis.coverage.status, 'partial');
  });

  it('keeps recovered source files separate from shipped files, with clean paths', () => {
    const sources = ofKind(p, 'source-file');
    assert.equal(sources.length, reaKindCount(raw, 'source-module'));
    assert.ok(sources.every((s) => !s.path.startsWith('webpack://')), 'paths come from the source-map resolution');
    assert.ok(sources.every((s) => s.originalName.length > 0 && s.sourceMapPath.length > 0));
  });

  it('reports dynamic IPC channels as unresolved instead of inventing names', () => {
    const channels = ofKind(p, 'ipc-channel');
    assert.ok(channels.length > 0);
    for (const c of channels) {
      assert.equal(c.resolution, 'dynamic');
      assert.equal(c.channel, null);
      assert.equal(c.channelExpression, 'e');
    }
    const ipc = finding(p, 'ipc');
    assert.equal(ipc.unresolvedCount, 7);
    assert.ok(ipc.notes.some((n) => n.includes('dynamic channel names')));
  });

  it('surfaces analysis gaps and files that lost relationships', () => {
    assert.equal(ofKind(p, 'analysis-gap').length, reaKindCount(raw, 'unknown'));
    assert.ok(p.analysis.filesWithAnalysisIssues > 0);
    assert.equal(p.analysis.filesWithAnalysisIssues, ofKind(p, 'file').filter((f) => f.analysisIssue?.code === 'resource_constraint').length);
    assert.ok(finding(p, 'imports').notes.some((n) => n.includes('REA resource limits')));
  });

  it('reports windows and bridges as not-found (not absent) on this bundle', () => {
    assert.equal(finding(p, 'windows').status, 'not-found');
    assert.equal(finding(p, 'bridge-apis').status, 'not-found');
  });

  it('passes endpoints through unfiltered', () => {
    assert.equal(ofKind(p, 'endpoint').length, reaKindCount(raw, 'endpoint'));
    assert.ok(ofKind(p, 'endpoint').some((e) => e.value === 'POST /gists' && e.mechanism === 'call:request'));
  });

  it('keeps native add-ons and storage keys', () => {
    assert.equal(ofKind(p, 'native-addon').length, 11);
    assert.ok(ofKind(p, 'storage').some((s) => s.name === 'zoom-factor' && s.storageKind === 'local-storage'));
  });
});

describe('.asar input (tiny-electron packed with @electron/asar)', () => {
  const TINY_ASAR = 'tiny-electron-asar.rea-6.4.0.json';
  type Raw = { normalized_result: { graph: { nodes: { node_id: string; kind: string }[]; edges: { source_node_id: string; relation: string }[] } } };
  const kindCounts = (p: StudioProject) => p.nodes.reduce<Record<string, number>>((m, n) => ((m[n.kind] = (m[n.kind] ?? 0) + 1), m), {});

  it('produces the same project as the extracted directory, without gaps', () => {
    const { project: fromAsar, report } = adaptReaResult(load(TINY_ASAR), opts);
    const fromDir = toStudioProject(load(TINY), opts);
    assertInvariants(fromAsar);
    assert.equal(fromAsar.target.format, 'asar');
    assert.equal(fromAsar.target.name, 'tiny-electron');
    assert.deepEqual(kindCounts(fromAsar), kindCounts(fromDir));
    assert.equal(fromAsar.edges.length, fromDir.edges.length);
    assert.equal(ofKind(fromAsar, 'analysis-gap').length, 0);
    assert.deepEqual(report.unrecognizedNodeKinds, {});
    assert.equal(report.foldedAsarEntries, 7);
  });

  it('lists each archived file once and keeps the archive evidence on it', () => {
    const p = toStudioProject(load(TINY_ASAR), opts);
    const paths = ofKind(p, 'file').map((f) => f.path);
    assert.equal(paths.length, new Set(paths).size, 'no duplicate files');
    const main = ofKind(p, 'file').find((f) => f.path === 'src/main/main.js');
    assert.deepEqual(main?.evidence.map((e) => e.extractor).sort(), ['inventory-asar-entry', 'inventory-relevant-file']);
    const root = ofKind(p, 'file').find((f) => f.path === '');
    const containedFiles = p.edges
      .filter((e) => e.source === root?.id && e.relation === 'contains')
      .map((e) => p.nodes.find((n) => n.id === e.target))
      .flatMap((n) => (n?.kind === 'file' ? [n.path] : []))
      .sort();
    assert.deepEqual(containedFiles, paths.filter((x) => x !== '').sort(), 'root contains every archived file directly');
  });

  it('keeps an entry as its own file when it maps to nothing', () => {
    const raw = structuredClone(load(TINY_ASAR)) as Raw;
    const g = raw.normalized_result.graph;
    const entry = g.nodes.find((n) => n.kind === 'asar-entry');
    assert.ok(entry);
    g.edges = g.edges.filter((e) => !(e.source_node_id === entry.node_id && e.relation === 'maps_to'));
    const p = toStudioProject(raw, opts);
    const kept = p.nodes.find((n) => n.id === entry.node_id);
    assert.equal(kept?.kind, 'file');
    assert.equal(kept?.kind === 'file' && kept.fileKind, 'other');
  });

  it('uses targetName when REA reports no root package', () => {
    const raw = structuredClone(load(TINY_ASAR)) as Raw;
    raw.normalized_result.graph.nodes = raw.normalized_result.graph.nodes.filter((n) => n.kind !== 'package');
    assert.equal(toStudioProject(raw, { ...opts, targetName: 'obsidian.asar' }).target.name, 'obsidian.asar');
  });

  it('drops archive-folding self links while preserving genuine self relationships', () => {
    const raw = structuredClone(load(TINY_ASAR)) as ReaResult;
    const g = raw.normalized_result.graph;
    const file = g.nodes.find((n) => n.kind === 'javascript-asset');
    const edge = g.edges[0];
    assert.ok(file && edge);
    g.edges.push({ ...edge, edge_id: 'original-self-edge', source_node_id: file.node_id,
      target_node_id: file.node_id, relation: 'imports' });
    const { project, report } = adaptReaResult(raw, opts);
    assert.ok(project.edges.some((e) => e.id === 'original-self-edge' && e.source === e.target));
    assert.equal(report.droppedSelfEdges, 7);
  });

  it('calls an app Electron when only renderer/preload processes are found', () => {
    const raw = structuredClone(load(TINY_ASAR)) as Raw;
    const g = raw.normalized_result.graph;
    g.nodes = g.nodes.filter((n) => n.kind !== 'electron-main');
    assert.equal(toStudioProject(raw, opts).target.appKind, 'electron');
    g.nodes = g.nodes.filter((n) => !n.kind.startsWith('electron-'));
    assert.equal(toStudioProject(raw, opts).target.appKind, 'javascript');
  });
});

describe('heuristic: bridge member reads', () => {
  const heuristicEdges = (p: StudioProject) => p.edges.filter((e) => e.origin.source === 'studio-heuristic');

  it('links renderer reads of window.<apiKey>.<member> to the bridge (tiny-electron)', () => {
    const { project: p, report } = adaptReaResult(load(TINY), opts);
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    const links = heuristicEdges(p)
      .map((e) => {
        const src = byId.get(e.source);
        const dst = byId.get(e.target);
        const loc = e.evidence.location;
        return {
          from: src?.kind === 'file' ? src.path : null,
          to: dst?.kind === 'bridge-api' ? dst.apiKey : null,
          relation: e.relation,
          via: e.details.mechanism,
          at: loc?.kind === 'source-range' ? `${loc.file}:${loc.start.line}` : null,
        };
      })
      .sort((a, b) => String(a.via).localeCompare(String(b.via)));
    assert.deepEqual(links, [
      { from: 'src/renderer/renderer.js', to: 'notesApi', relation: 'calls', via: 'window.notesApi.list', at: 'src/renderer/renderer.js:6' },
      { from: 'src/renderer/renderer.js', to: 'notesApi', relation: 'calls', via: 'window.notesApi.save', at: 'src/renderer/renderer.js:5' },
    ]);
    assert.deepEqual(report.heuristicEdges, { 'bridge-member-read': 2 });
  });

  it('labels heuristic edges as inferred studio heuristics and leaves REA edges untouched', () => {
    const withHeuristics = toStudioProject(load(TINY), opts);
    for (const e of heuristicEdges(withHeuristics)) {
      assert.equal(e.origin.source === 'studio-heuristic' && e.origin.heuristic, 'bridge-member-read');
      assert.equal(e.evidence.state, 'inferred');
      assert.equal(e.evidence.confidence, 'medium');
      assert.equal(e.evidence.authority, 'studio-heuristic');
    }
    const reaEdges = withHeuristics.edges.filter((e) => e.origin.source === 'rea');
    assert.equal(reaEdges.length, withHeuristics.edges.length - 2);
    assert.equal(reaEdges.length, 56, 'same REA edges as before heuristics');
  });

  it('adds nothing when the app has no bridge API (GitHub Desktop)', () => {
    const { project, report } = adaptReaResult(load(GHD), opts);
    assert.equal(heuristicEdges(project).length, 0);
    assert.deepEqual(report.heuristicEdges, { 'bridge-member-read': 0 });
  });

  it('ignores reads of members the bridge does not expose', () => {
    const raw = structuredClone(load(TINY)) as {
      normalized_result: { semantic_graph: { nodes: { label?: string; properties?: Record<string, unknown> }[] } };
    };
    const read = raw.normalized_result.semantic_graph.nodes.find((n) => n.label === 'read:/notesApi/save');
    assert.ok(read?.properties);
    read.properties['property_path'] = ['notesApi', 'deleteEverything'];
    const vias = heuristicEdges(toStudioProject(raw, opts)).map((e) => e.details.mechanism);
    assert.deepEqual(vias, ['window.notesApi.list']);
  });
});

describe('defensive handling', () => {
  const clone = () => structuredClone(load(TINY)) as {
    operation: string;
    subject: { digest?: { sha256?: string } };
    normalized_result: { graph: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } };
  };

  it('rejects input that is not REA application analysis', () => {
    assert.throws(() => toStudioProject(null, opts), ReaOutputError);
    assert.throws(() => toStudioProject('x', opts), ReaOutputError);
    const wrongOp = clone();
    wrongOp.operation = 'analyze_web_bundle';
    assert.throws(() => toStudioProject(wrongOp, opts), /Unsupported REA operation/);
    const noGraph = clone() as unknown as { normalized_result: Record<string, unknown> };
    delete noGraph.normalized_result['graph'];
    assert.throws(() => toStudioProject(noGraph, opts), /normalized_result.graph/);
    const noDigest = clone();
    delete noDigest.subject.digest;
    assert.throws(() => toStudioProject(noDigest, opts), /sha256/);
  });

  it('keeps unknown REA node kinds visible as gaps and drops unknown relations', () => {
    const raw = clone();
    const g = raw.normalized_result.graph;
    g.nodes.push({ node_id: 'future-1', kind: 'future-kind', observations: [{ label: 'x', properties: {}, evidence: { state: 'observed', confidence: 'exact' } }] });
    const first = g.nodes[0]?.['node_id'];
    g.edges.push({ edge_id: 'e-future', source_node_id: first, target_node_id: 'future-1', relation: 'teleports', properties: {}, evidence: {} });
    g.edges.push({ edge_id: 'e-dangling', source_node_id: first, target_node_id: 'missing', relation: 'contains', properties: {}, evidence: {} });
    const { project, report } = adaptReaResult(raw, opts);
    const gap = project.nodes.find((n) => n.id === 'future-1');
    assert.equal(gap?.kind, 'analysis-gap');
    assert.deepEqual(report.unrecognizedNodeKinds, { 'future-kind': 1 });
    assert.deepEqual(report.droppedEdgesUnknownRelation, { teleports: 1 });
    assert.equal(report.droppedEdgesDanglingEndpoint, 1);
    assertInvariants(project);
  });

  it('maps unknown evidence values to the weakest member instead of guessing', () => {
    const raw = clone();
    const ev = (raw.normalized_result.graph.edges[0] as { evidence: Record<string, unknown> }).evidence;
    ev['confidence'] = 'very-high';
    ev['state'] = 'rumored';
    const edge = toStudioProject(raw, opts).edges.find((e) => e.id === raw.normalized_result.graph.edges[0]?.['edge_id']);
    assert.equal(edge?.evidence.confidence, 'unknown');
    assert.equal(edge?.evidence.state, 'unavailable');
  });

  it('does not merge relative specifiers from different modules', () => {
    const raw = clone();
    const ref = (id: string) => ({
      node_id: id,
      kind: 'javascript-module',
      observations: [{ label: './types.js', properties: { semantic_role: 'module-reference', declared_specifier: './types.js', resolution_status: 'not-found' }, evidence: {} }],
    });
    raw.normalized_result.graph.nodes.push(ref('rel-a'), ref('rel-b'));
    const ext = ofKind(toStudioProject(raw, opts), 'external-module').filter((e) => e.specifier === './types.js');
    assert.deepEqual(ext.map((e) => e.id).sort(), ['rel-a', 'rel-b']);
  });
});

// Optional: the full untrimmed output (50 MB) isn't committed. Point REA_FULL_FIXTURE at it to run.
const full = process.env['REA_FULL_FIXTURE'];
describe('full REA output (optional)', { skip: !full || !existsSync(full) }, () => {
  it('adapts without dangling edges', () => {
    const p = toStudioProject(JSON.parse(readFileSync(full ?? '', 'utf8')), opts);
    assertInvariants(p);
  });
});
