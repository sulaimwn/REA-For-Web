// Linux programs (T028): the tiny-linux ELF fixture (REA + Ghidra, collected in the native worker image)
// against its answer key (fixtures/sample-apps/tiny-linux/ANSWER-KEY.md).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { NATIVE_FINDING_CATEGORIES, type StudioNode } from '@rea-studio/schema';
import { adaptReaResult, ReaOutputError } from '../src/index.js';

const samples = new URL('../../../../fixtures/samples/', import.meta.url);
const raw = JSON.parse(readFileSync(new URL('tiny-linux.rea-6.4.0.json', samples), 'utf8')) as Record<string, unknown>;
const { project } = adaptReaResult(raw, { reaVersion: '6.4.0', targetName: 'tiny-notes' });
const byId = new Map(project.nodes.map((n) => [n.id, n]));
const of = <K extends StudioNode['kind']>(k: K) => project.nodes.filter((n): n is Extract<StudioNode, { kind: K }> => n.kind === k);
const from = (fn: string) => {
  const f = of('native-function').find((n) => n.name === fn);
  return project.edges.filter((e) => e.source === f?.id).map((e) => `${e.relation}:${byId.get(e.target)?.label}`).sort();
};

describe('Linux ELF program (REA + Ghidra) adapter', () => {
  it('uses evidence collected from the committed ELF bytes', () => {
    const bytes = readFileSync(new URL('../sample-apps/tiny-linux/tiny-notes', samples));
    assert.deepEqual([...bytes.subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46]);
    assert.equal(project.target.sha256, createHash('sha256').update(bytes).digest('hex'));
  });

  it('rejects missing, unsupported and inherited-property formats instead of inventing PE evidence', () => {
    for (const format of [undefined, null, 'unknown', 'constructor', '__proto__', 'macho', 'mach-o', {}, []]) {
      const changed = structuredClone(raw);
      const overview = changed['binary_overview'] as { subject: { format?: unknown } };
      overview.subject.format = format;
      assert.throws(() => adaptReaResult(changed, { reaVersion: '6.4.0' }), ReaOutputError);
    }
  });

  it('identifies an ELF native program', () => {
    assert.deepEqual([project.target.format, project.target.appKind, project.target.name], ['elf', 'native', 'tiny-notes']);
    assert.deepEqual(project.findings.map((f) => f.category), [...NATIVE_FINDING_CATEGORIES]);
    assert.equal(project.analysis.coverage.status, 'complete');
    assert.ok(project.analysis.limitations.some((l) => /collected ELF imports identify symbols/u.test(l)));
  });

  it('draws the call graph from the answer key', () => {
    assert.deepEqual(from('main'), ['calls:puts', 'calls:remember_last', 'calls:save_note', 'calls:sync_notes']);
    assert.deepEqual(from('save_note'), ['calls:fclose', 'calls:fopen', 'calls:fwrite', 'calls:strlen', 'persists_to:notes.txt']);
    assert.deepEqual(from('remember_last'), ['calls:fclose', 'calls:fopen', 'calls:fprintf', 'persists_to:settings.ini']);
    assert.deepEqual(from('sync_notes'), [
      'calls:close', 'calls:connect', 'calls:freeaddrinfo', 'calls:getaddrinfo', 'calls:https://api.example.com/notes',
      'calls:send', 'calls:snprintf', 'calls:socket', 'calls:strlen',
    ]);
  });

  it('names imports by symbol, without inventing a library', () => {
    const imports = of('native-import');
    assert.ok(imports.length >= 14);
    for (const i of imports) {
      assert.equal(i.library, '', i.label);
      assert.equal(i.label, i.entryPoint);
    }
    assert.deepEqual(project.findings.find((f) => f.category === 'native-imports')?.notes, ['Imported symbols; providing libraries are not recorded in this collected evidence']);
  });

  it('marks _start as the entry point', () => {
    assert.deepEqual(of('native-function').filter((f) => f.entryPoint).map((f) => f.name), ['_start']);
  });
});
