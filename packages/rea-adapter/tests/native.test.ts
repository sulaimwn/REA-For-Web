// Native programs (T021): the tiny-native fixture (REA + Ghidra) against its answer key
// (fixtures/sample-apps/tiny-native/ANSWER-KEY.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NATIVE_FINDING_CATEGORIES, NODE_KINDS, RELATIONS, type StudioNode } from '@rea-studio/schema';
import { adaptReaResult, interestingNativeStrings, isNativeBundle, nativeProcedureAddresses, ReaOutputError, toStudioProject } from '../src/index.js';
import { collectNativeBundle } from '../src/native-session.js';

const samples = new URL('../../../../fixtures/samples/', import.meta.url);
const raw = JSON.parse(readFileSync(new URL('tiny-native.rea-6.4.0.json', samples), 'utf8')) as Record<string, unknown>;
const { project } = adaptReaResult(raw, { reaVersion: '6.4.0', targetName: 'tiny-notes.exe' });
const byId = new Map(project.nodes.map((n) => [n.id, n]));
const name = (n: StudioNode | undefined) =>
  !n ? '?' : n.kind === 'native-import' ? `${n.library}!${n.entryPoint}` : n.kind === 'native-function' ? n.name : n.label;
const from = (fn: string) => {
  const f = project.nodes.find((n) => n.kind === 'native-function' && n.name === fn);
  return project.edges.filter((e) => e.source === f?.id).map((e) => `${e.relation}:${name(byId.get(e.target))}`).sort();
};

describe('native program (REA + Ghidra) adapter', () => {
  it('identifies a native program', () => {
    assert.equal(isNativeBundle(raw), true);
    assert.equal(project.target.appKind, 'native');
    assert.equal(project.target.name, 'tiny-notes.exe');
    assert.match(project.id, /^[a-f0-9]{64}$/);
    assert.deepEqual(project.findings.map((f) => f.category), [...NATIVE_FINDING_CATEGORIES]);
  });

  it('draws the call graph from the answer key, with imports folded from their thunks', () => {
    assert.deepEqual(from('wWinMain'), ['calls:USER32.DLL!MessageBoxW', 'calls:remember_last', 'calls:save_note', 'calls:sync_notes', 'persists_to:note.txt']);
    assert.deepEqual(from('save_note'), ['calls:KERNEL32.DLL!CloseHandle', 'calls:KERNEL32.DLL!CreateFileW', 'calls:KERNEL32.DLL!WriteFile', 'calls:MSVCRT.DLL!strlen']);
    assert.deepEqual(from('remember_last'), ['calls:ADVAPI32.DLL!RegCloseKey', 'calls:ADVAPI32.DLL!RegCreateKeyExW', 'calls:ADVAPI32.DLL!RegSetValueExW', 'calls:MSVCRT.DLL!wcslen', 'persists_to:Software\\TinyNotes']);
    assert.deepEqual(from('sync_notes'), ['calls:WININET.DLL!InternetCloseHandle', 'calls:WININET.DLL!InternetOpenUrlW', 'calls:WININET.DLL!InternetOpenW', 'calls:https://api.example.com/notes']);
  });

  it('lists functions, imports by library, and the URL and storage strings', () => {
    const of = <K extends StudioNode['kind']>(k: K) => project.nodes.filter((n): n is Extract<StudioNode, { kind: K }> => n.kind === k);
    assert.equal(of('native-function').length, 49);
    assert.ok(of('native-function').some((f) => f.entryPoint));
    const libs = new Set(of('native-import').map((i) => i.library));
    for (const lib of ['KERNEL32.DLL', 'ADVAPI32.DLL', 'WININET.DLL', 'USER32.DLL']) assert.ok(libs.has(lib), lib);
    assert.deepEqual(of('endpoint').map((e) => e.value), ['https://api.example.com/notes']);
    assert.deepEqual(of('storage').map((s) => [s.storageKind, s.name]).sort(), [['file', 'note.txt'], ['registry', 'Software\\TinyNotes']]);
  });

  it('uses only schema kinds and relations, with no dangling edges', () => {
    for (const n of project.nodes) assert.ok((NODE_KINDS as readonly string[]).includes(n.kind), n.kind);
    for (const e of project.edges) {
      assert.ok((RELATIONS as readonly string[]).includes(e.relation));
      assert.ok(byId.has(e.source) && byId.has(e.target), e.id);
    }
    assert.equal(new Set(project.edges.map((e) => e.id)).size, project.edges.length);
  });

  it('tells the collector what to query next', () => {
    assert.equal(nativeProcedureAddresses(raw['list_procedures']).length, Object.keys(raw['procedure_callees'] as object).length);
    assert.equal(interestingNativeStrings(raw['list_strings']).length, 3);
  });

  it('rejects a bundle without a digest', () => {
    assert.throws(() => toStudioProject({ binary_overview: {}, list_procedures: { normalized_result: [] } }, { reaVersion: '6.4.0' }), ReaOutputError);
  });

  it('keeps observed strings but labels classification and behavioral links as Studio inference', () => {
    const stringNodes = project.nodes.filter((n) => n.kind === 'endpoint' || n.kind === 'storage');
    assert.equal(stringNodes.length, 3);
    for (const n of stringNodes) {
      assert.equal(n.origin.source, 'studio-heuristic');
      assert.ok(n.evidence.some((e) => e.state === 'observed' && e.extractor === 'list_strings'));
      assert.ok(n.evidence.some((e) => e.state === 'inferred' && e.authority === 'studio-heuristic'));
      for (const edge of project.edges.filter((e) => e.target === n.id && e.relation !== 'contains')) {
        assert.equal(edge.origin.source, 'studio-heuristic');
        assert.equal(edge.evidence.state, 'inferred');
        assert.ok(edge.evidence.limitations.some((l) => /how it uses it is not analyzed/.test(l)));
      }
    }
    assert.ok(project.edges.some((e) => e.relation === 'calls' && e.origin.source === 'rea' && e.evidence.state === 'observed'));
    assert.ok(project.analysis.limitations.some((l) => /Only Ghidra-defined string Data/.test(l)));
  });

  it('marks missing query results as partial and preserves warnings from every query', () => {
    const changed = structuredClone(raw);
    const calls = changed['procedure_callees'] as Record<string, { limitations: string[] }>;
    delete calls[Object.keys(calls)[0]!];
    Object.values(calls).at(-1)!.limitations.push('Later call warning');
    const p = adaptReaResult(changed, { reaVersion: '6.4.0' }).project;
    assert.equal(p.analysis.coverage.status, 'partial');
    assert.ok(p.analysis.limitations.includes('Later call warning'));
    assert.ok(p.analysis.limitations.some((l) => /1 callee queries/.test(l)));
  });
});

describe('native session (MCP client for `rea --mcp`)', () => {
  const fakeRea = fileURLToPath(new URL('../../tests/helpers/fake-rea-mcp.mjs', import.meta.url));
  const env = { ...process.env, FAKE_REA_FIXTURE: fileURLToPath(new URL('tiny-native.rea-6.4.0.json', samples)) };

  it('collects exactly the bundle the adapter reads, answering server pings', async () => {
    const progress: string[] = [];
    const bundle = await collectNativeBundle({ reaScript: fakeRea, program: 'tiny-notes.exe', env, onProgress: (m) => progress.push(m) });
    assert.deepEqual(bundle, raw);
    assert.equal(progress.length, 1);
  });

  it('reports a failed REA tool with its message', async () => {
    await assert.rejects(
      collectNativeBundle({ reaScript: fakeRea, program: 'x.exe', env: { ...env, FAKE_REA_FAIL: 'open_binary' } }),
      /REA open_binary failed: provider_unavailable/,
    );
  });

  it('fails cleanly when REA exits', async () => {
    await assert.rejects(collectNativeBundle({ reaScript: fakeRea, program: 'x.exe', env: { ...env, FAKE_REA_FIXTURE: 'missing.json' } }), /exited/);
  });
});
