// Real-world sample projects (T031): small open-source apps, checked for the facts the demos rely on.
// Sources and checksums: fixtures/sample-apps/real-world.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { StudioNode, StudioProject } from '@rea-studio/schema';
import { toStudioProject } from '../src/index.js';

const samples = new URL('../../../../fixtures/samples/', import.meta.url);
const load = (file: string, targetName?: string) =>
  toStudioProject(JSON.parse(readFileSync(new URL(file, samples), 'utf8')), { reaVersion: '6.4.0', ...(targetName ? { targetName } : {}) });
const of = <K extends StudioNode['kind']>(p: StudioProject, k: K) => p.nodes.filter((n): n is Extract<StudioNode, { kind: K }> => n.kind === k);
const notes = (p: StudioProject, category: string) => p.findings.find((f) => f.category === category)?.notes ?? [];

describe('Caprine 2.61.0 (Electron, trimmed)', () => {
  const p = load('caprine-2.61.0.trimmed.rea-6.4.0.json');
  it('finds its processes, window and IPC', () => {
    assert.deepEqual([p.target.name, p.target.version, p.target.appKind], ['caprine', '2.61.0', 'electron']);
    assert.deepEqual(of(p, 'process').map((n) => n.role).sort(), ['main', 'preload', 'preload', 'renderer']);
    assert.equal(of(p, 'window').length, 1);
    assert.ok(of(p, 'ipc-channel').length >= 10);
  });
  it('keeps REA’s honest coverage: partial, with no gaps drawn for dependencies the trim dropped', () => {
    assert.equal(p.analysis.coverage.status, 'partial');
    assert.ok(of(p, 'analysis-gap').every((g) => !g.path.startsWith('node_modules/')));
  });
});

describe('jq 1.8.2 (native Windows .exe)', () => {
  const p = load('jq-1.8.2-windows.rea-6.4.0.json', 'jq.exe');
  it('maps functions and Windows imports of a stripped release binary', () => {
    assert.deepEqual([p.target.name, p.target.format, p.target.appKind], ['jq.exe', 'pe', 'native']);
    assert.ok(of(p, 'native-function').length > 800);
    assert.ok(of(p, 'native-import').some((i) => i.library === 'KERNEL32.DLL'));
    assert.match(notes(p, 'functions')[0] ?? '', /FUN_<address>/u);
  });
});

describe('jq 1.8.2 (macOS Mach-O, collected in the native image) (T035)', () => {
  const p = load('jq-1.8.2-macos.rea-6.4.0.json', 'jq');
  it('maps REA’s "mach-o" format, its functions and the libSystem imports', () => {
    assert.deepEqual([p.target.name, p.target.format, p.target.appKind], ['jq', 'macho', 'native']);
    assert.equal(p.target.sha256, 'e94b266e3c26690550006abe63152b782280f4e14374accdf04cbde844f00bc0');
    // REA lists 1,667 functions; 130 are Ghidra thunks (Mach-O import stubs), which stand for their imports.
    assert.equal(of(p, 'native-function').length, 1_537);
    const imports = of(p, 'native-import');
    assert.equal(imports.length, 130);
    // Unlike ELF, Mach-O imports name their providing library.
    assert.ok(imports.every((i) => i.library === '/usr/lib/libSystem.B.dylib'));
    assert.deepEqual(notes(p, 'native-imports'), ['Libraries: /usr/lib/libSystem.B.dylib']);
    assert.ok(of(p, 'native-function').some((f) => f.name === 'entry' && f.entryPoint));
    assert.ok(!p.analysis.limitations.some((l) => /ELF/u.test(l)));
  });
  it('still refuses a native bundle whose format REA did not record', () => {
    const raw = JSON.parse(readFileSync(new URL('jq-1.8.2-macos.rea-6.4.0.json', samples), 'utf8'));
    raw.binary_overview.subject.format = 'macho';
    assert.throws(() => toStudioProject(raw, { reaVersion: '6.4.0' }), /no supported, recorded binary format/u);
  });
});

describe('Binary Eye 1.75.5 (Android, minified)', () => {
  const p = load('binaryeye-1.75.5.rea-6.4.0.json');
  it('reads the manifest: components, permissions and the launcher', () => {
    assert.deepEqual([p.target.name, p.target.appKind], ['de.markusfisch.android.binaryeye', 'android']);
    assert.ok(of(p, 'android-component').length >= 15);
    assert.ok(of(p, 'android-permission').some((n) => n.name === 'android.permission.CAMERA'));
    assert.ok(of(p, 'android-component').some((c) => c.launcher));
  });
  it('counts omitted default-package classes and labels the minification explanation as a heuristic', () => {
    assert.ok(notes(p, 'types').some((n) => /^JADX lists \d{4} more classes under defpackage/u.test(n)), notes(p, 'types').join(' | '));
    assert.ok(notes(p, 'types').some((n) => /Studio heuristic:.*names alone do not identify their origin/u.test(n)));
  });
});
