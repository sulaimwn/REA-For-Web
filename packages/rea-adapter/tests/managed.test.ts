// .NET (T021): the tiny-dotnet fixture against its answer key
// (fixtures/sample-apps/tiny-dotnet/ANSWER-KEY.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DOTNET_FINDING_CATEGORIES, NODE_KINDS, RELATIONS, type StudioNode } from '@rea-studio/schema';
import { adaptReaResult, isManagedBundle, ReaOutputError, toStudioProject } from '../src/index.js';

const samples = new URL('../../../../fixtures/samples/', import.meta.url);
const raw = JSON.parse(readFileSync(new URL('tiny-dotnet.rea-6.4.0.json', samples), 'utf8')) as Record<string, unknown>;
const opts = { reaVersion: '6.4.0' };
const { project, report } = adaptReaResult(raw, opts);
const of = <K extends StudioNode['kind']>(kind: K) => project.nodes.filter((n): n is Extract<StudioNode, { kind: K }> => n.kind === kind);
const byId = new Map(project.nodes.map((n) => [n.id, n]));
const name = (id: string) => {
  const n = byId.get(id);
  if (!n) return '?';
  if (n.kind === 'managed-method') return `${n.declaringType}.${n.name}`;
  if (n.kind === 'external-member' || n.kind === 'assembly') return n.name;
  if (n.kind === 'native-import') return `${n.library}!${n.entryPoint}`;
  if (n.kind === 'managed-type') return n.fullName;
  return n.label;
};
const callsFrom = (method: string) =>
  project.edges.filter((e) => e.relation === 'calls' && name(e.source) === method).map((e) => name(e.target)).sort();

describe('tiny-dotnet (.NET) adapter', () => {
  it('recognizes the bundle and identifies a .NET program', () => {
    assert.equal(isManagedBundle(raw), true);
    assert.equal(project.target.appKind, 'dotnet');
    assert.equal(project.target.format, 'pe');
    assert.equal(project.target.name, 'TinyNotes');
    assert.equal(project.target.version, '1.2.3.0');
    assert.match(project.id, /^[a-f0-9]{64}$/);
    assert.equal(project.analysis.engine.operation, 'project_managed_application_graph');
  });

  it('builds one assembly node with references, resources and the entry point', () => {
    const [assembly] = of('assembly');
    assert.equal(of('assembly').length, 1);
    assert.ok(assembly);
    assert.equal(assembly.moduleName, 'TinyNotes.exe');
    assert.equal(assembly.entryPoint, 'TinyNotes.Program.Main');
    assert.equal(assembly.architecture, 'anycpu');
    assert.equal(assembly.ilOnly, true);
    assert.deepEqual(assembly.references.map((r) => r.name), ['mscorlib', 'System.Net.Http']);
    assert.deepEqual(assembly.resources, [{ name: 'TinyNotes.Strings.txt', bytes: 29, embedded: true }]);
    // The artifact and module records are folded in, keeping their evidence.
    assert.ok(assembly.evidence.length >= 3);
  });

  it('keeps every type and method, with fields listed on their type', () => {
    assert.equal(of('managed-type').length, 6);
    assert.equal(of('managed-method').length, 10);
    const store = of('managed-type').find((t) => t.fullName === 'TinyNotes.NoteStore');
    assert.deepEqual(store?.fields, ['root']);
    assert.equal(of('managed-type').filter((t) => t.compilerGenerated).length, 2); // <Module>, <PushAsync>d__0
    assert.equal(of('managed-method').find((m) => m.entryPoint)?.name, 'Main');
  });

  it('finds the three P/Invoke native calls and links their declaring methods', () => {
    const imports = of('native-import').map((i) => `${i.library}!${i.entryPoint}:${i.callingConvention}`).sort();
    assert.deepEqual(imports, ['kernel32.dll!GetTickCount64:winapi', 'tinycrypto.dll!seal_note:cdecl', 'user32.dll!MessageBoxW:winapi']);
    const pinvokes = of('managed-method').filter((m) => m.pinvoke).map((m) => m.name).sort();
    assert.deepEqual(pinvokes, ['GetTickCount64', 'MessageBoxW', 'SealNote']);
    const sealImport = project.edges.find((e) => e.relation === 'imports' && name(e.source) === 'TinyNotes.Native.SealNote');
    assert.equal(sealImport && name(sealImport.target), 'tinycrypto.dll!seal_note');
  });

  it('draws the call graph from REA call edges, including file and network APIs', () => {
    assert.deepEqual(callsFrom('TinyNotes.Program.Main').filter((n) => n.startsWith('TinyNotes.')), [
      'TinyNotes.Native.GetTickCount64',
      'TinyNotes.Native.MessageBoxW',
      'TinyNotes.Native.SealNote',
      'TinyNotes.NoteStore..ctor',
      'TinyNotes.NoteStore.Load',
      'TinyNotes.NoteStore.Save',
      'TinyNotes.Sync.PushAsync',
    ]);
    assert.ok(callsFrom('TinyNotes.NoteStore.Save').includes('WriteAllText'));
    assert.ok(callsFrom('TinyNotes.NoteStore.Load').includes('ReadAllText'));
    assert.ok(callsFrom('<PushAsync>d__0.MoveNext').includes('PostAsync'));
    // REA doesn't name generic instantiations (method-spec targets); they're reported, not invented.
    assert.equal(report.skippedManagedCalls?.['method-spec'], 2);
    for (const e of project.edges.filter((x) => x.relation === 'calls')) {
      assert.equal(e.origin.source, 'rea');
      assert.ok((e.details.callSites ?? 0) >= 1);
      assert.match(e.details.mechanism ?? '', /^(call|callvirt|newobj)$/);
    }
  });

  it('uses only schema kinds and relations, with no dangling edges', () => {
    for (const n of project.nodes) assert.ok((NODE_KINDS as readonly string[]).includes(n.kind), n.kind);
    for (const e of project.edges) {
      assert.ok((RELATIONS as readonly string[]).includes(e.relation), e.relation);
      assert.ok(byId.has(e.source) && byId.has(e.target), e.id);
    }
    assert.equal(new Set(project.edges.map((e) => e.id)).size, project.edges.length);
    assert.deepEqual(report.unrecognizedNodeKinds, {});
    assert.equal(report.droppedEdgesDanglingEndpoint, 0);
  });

  it('reports .NET findings only, with REA coverage passed through', () => {
    assert.deepEqual(project.findings.map((f) => f.category), [...DOTNET_FINDING_CATEGORIES]);
    assert.deepEqual(project.findings.map((f) => [f.category, f.count]), [
      ['types', 6],
      ['methods', 10],
      ['native-imports', 3],
      ['external-apis', of('external-member').length],
    ]);
    assert.equal(project.analysis.coverage.status, 'partial');
    assert.deepEqual(project.analysis.omitted, ['managed-fields']);
  });

  it('works without the members inspection, and says calls are missing', () => {
    const { inspect_managed_members: _members, ...rest } = raw;
    const p = toStudioProject(rest, opts);
    assert.equal(p.edges.filter((e) => e.relation === 'calls').length, 0);
    assert.ok(p.analysis.limitations.some((l) => l.includes('calls between methods')));
  });

  it('rejects a bundle whose projection is missing or malformed', () => {
    assert.throws(() => toStudioProject({ project_managed_application_graph: { operation: 'other' } }, opts), ReaOutputError);
    assert.throws(() => toStudioProject({ project_managed_application_graph: null }, opts), ReaOutputError);
  });
});
