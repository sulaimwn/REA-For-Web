import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { STUDIO_SCHEMA_VERSION, type StudioProject } from '@rea-studio/schema';
import { findChrome } from '../src/browser.js';

// Compiled to dist-tests/tests/; the built CLI is dist/cli.js and the repo root is four levels up.
const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const tiny = fileURLToPath(new URL('../../../../fixtures/sample-apps/tiny-electron', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'rea-studio-cli-test-'));
after(() => rmSync(work, { recursive: true, force: true }));

/** Runs the CLI with optional environment changes (`undefined` removes a variable). */
const runWith = (env: Record<string, string | undefined>, ...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, INIT_CWD: work, ...env }, timeout: 300_000 });
const run = (...args: string[]) => runWith({}, ...args);
const tinyApk = fileURLToPath(new URL('../../../../fixtures/sample-apps/tiny-android/tiny-notes.apk', import.meta.url));
/** Like run, without blocking this process (a test can serve HTTP meanwhile). */
const runAsync = (...args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, INIT_CWD: work } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

describe('rea-studio analyze', () => {
  it('analyzes the tiny Electron sample into a StudioProject file', () => {
    const out = join(work, 'tiny.studio.json');
    const r = run('analyze', tiny, '--out', out);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /tiny-electron v1\.0\.0 \(electron\) · complete coverage/);
    assert.match(r.stdout, /ipc\s+3/);

    const text = readFileSync(out, 'utf8');
    const project = JSON.parse(text) as StudioProject;
    assert.equal(project.schemaVersion, STUDIO_SCHEMA_VERSION);
    assert.equal(project.target.name, 'tiny-electron');
    assert.equal(project.analysis.engine.version, '6.8.0');
    assert.equal(project.findings.find((f) => f.category === 'ipc')?.count, 3);
    // The file is meant to be shared; it must not contain the analyzing machine's paths.
    assert.ok(!text.includes(tiny), 'no absolute input path');
    assert.ok(!text.includes(tiny.replaceAll('\\', '\\\\')), 'no escaped absolute input path');
  });

  it('defaults the output name to <app>.studio.json next to where npm was run', () => {
    const r = run('analyze', tiny);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotThrow(() => readFileSync(join(work, 'tiny-electron.studio.json'), 'utf8'));
  });

  it('rejects missing paths and non-.asar files with a message', () => {
    const missing = run('analyze', join(work, 'nope'));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Not found/);

    const notAsar = join(work, 'app.zip');
    writeFileSync(notAsar, 'x');
    const wrong = run('analyze', notAsar);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /a directory, an \.asar file, an \.exe\/\.dll program, a Linux \(ELF\) or macOS \(Mach-O\) program or an \.apk/);
  });

  it('recognizes a Linux program by its ELF header, and explains where it can be analyzed (T028)', () => {
    const elf = fileURLToPath(new URL('../../../../fixtures/sample-apps/tiny-linux/tiny-notes', import.meta.url));
    const out = join(work, 'tiny-linux.studio.json');
    const r = runWith({ GHIDRA_INSTALL_DIR: undefined }, 'analyze', elf, '--out', out);
    assert.equal(r.status, 1);
    assert.match(r.stderr, process.platform === 'win32' ? /Linux or macOS machine/ : /GHIDRA_INSTALL_DIR/);
    assert.doesNotMatch(r.stderr, /    at /, 'no stack trace');
    assert.throws(() => readFileSync(out));
  });

  it('recognizes a macOS program by its Mach-O header, and asks for one architecture of a universal one (T035)', () => {
    // Headers only: the CLI decides from the first bytes and stops before any analysis.
    const thin = join(work, 'tool');
    writeFileSync(thin, Buffer.concat([Buffer.from('cffaedfe07000001', 'hex'), Buffer.alloc(56)]));
    const r = runWith({ GHIDRA_INSTALL_DIR: undefined }, 'analyze', thin, '--out', join(work, 'tool.studio.json'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, process.platform === 'win32' ? /macOS \(Mach-O\) programs need REA’s Ghidra on a Linux or macOS machine/ : /macOS \(Mach-O\) programs need REA’s Ghidra provider/);
    const fat = join(work, 'universal');
    writeFileSync(fat, Buffer.concat([Buffer.from('cafebabe00000002', 'hex'), Buffer.alloc(56)]));
    assert.match(run('analyze', fat).stderr, /universal \(multi-architecture\) macOS program/);
    // A Java class file shares 0xCAFEBABE; its version field (major 52) keeps it out of the Mach-O path.
    const javaClass = join(work, 'Notes.class');
    writeFileSync(javaClass, Buffer.concat([Buffer.from('cafebabe00000034', 'hex'), Buffer.alloc(56)]));
    assert.match(run('analyze', javaClass).stderr, /The app must be a directory/);
  });

  it('analyzes the tiny .NET sample (T021)', () => {
    const exe = fileURLToPath(new URL('../../../../fixtures/sample-apps/tiny-dotnet/TinyNotes.exe', import.meta.url));
    const out = join(work, 'tiny-dotnet.studio.json');
    const r = run('analyze', exe, '--out', out);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /TinyNotes v1\.2\.3\.0 \(dotnet\)/);
    assert.match(r.stdout, /native-imports\s+3/);
    const text = readFileSync(out, 'utf8');
    const project = JSON.parse(text) as StudioProject;
    assert.equal(project.target.appKind, 'dotnet');
    assert.equal(project.nodes.filter((n) => n.kind === 'managed-method').length, 10);
    assert.ok(project.edges.some((e) => e.relation === 'calls'));
    assert.ok(!text.includes(exe) && !text.includes(exe.replaceAll('\\', '\\\\')), 'no absolute input path');
  });

  it('explains that a non-.NET .exe needs Ghidra, leaving no output file', () => {
    const fake = join(work, 'not-dotnet.exe');
    writeFileSync(fake, 'MZ this is not a real program');
    const out = join(work, 'not-dotnet.studio.json');
    const r = runWith({ GHIDRA_INSTALL_DIR: undefined }, 'analyze', fake, '--out', out);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not \.NET|not as a \.NET program|couldn’t inspect|REA couldn’t analyze this file: \S/);
    assert.doesNotMatch(r.stderr, /    at /, 'no stack trace');
    assert.throws(() => readFileSync(out));
  });

  it('says an .apk needs REA’s JADX provider when it isn’t configured, leaving no output file', () => {
    const out = join(work, 'no-jadx.studio.json');
    const r = runWith({ REA_JADX_MCP_JAR: undefined }, 'analyze', tinyApk, '--out', out);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /REA_JADX_MCP_JAR/);
    assert.doesNotMatch(r.stderr, /    at /, 'no stack trace');
    assert.throws(() => readFileSync(out));
  });

  it('analyzes the tiny Android sample with REA’s JADX provider (T021)', (t) => {
    if (!process.env['REA_JADX_MCP_JAR']) return t.skip('REA_JADX_MCP_JAR is not set');
    const out = join(work, 'tiny-android.studio.json');
    const r = run('analyze', tinyApk, '--out', out);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /com\.reaforweb\.tinynotes v1\.2\.3 \(android\)/);
    assert.match(r.stdout, /components\s+4/);
    const project = JSON.parse(readFileSync(out, 'utf8')) as StudioProject;
    assert.deepEqual(project.nodes.filter((n) => n.kind === 'bridge-api').map((n) => n.label), ['window.notesBridge']);
  });

  it('prints usage for unknown commands and options', () => {
    assert.match(run('explode').stderr, /Usage: rea-studio analyze/);
    assert.match(run('analyze', tiny, '--fast').stderr, /Unknown option --fast/);
  });

  it('accepts --no-recover; a small app has nothing to recover either way (T008)', () => {
    const out = join(work, 'tiny-no-recover.studio.json');
    const r = run('analyze', tiny, '--no-recover', '--out', out);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /re-analyzing/);
    assert.doesNotMatch(r.stdout, /Re-analyzed/);
  });

  it('rejects an existing output without changing it or running REA', () => {
    const existing = join(work, 'keep.asar');
    writeFileSync(existing, 'original bytes');
    const r = run('analyze', existing, '--out', existing);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Output already exists/);
    assert.ok(!r.stderr.includes('Analyzing'));
    assert.equal(readFileSync(existing, 'utf8'), 'original bytes');
  });

  it('rejects missing option values and invalid heap limits', () => {
    assert.match(run('analyze', tiny, '--out').stderr, /needs a value/);
    assert.match(run('analyze', tiny, '--max-heap-mb', '--out', 'x').stderr, /needs a value/);
    assert.match(run('analyze', tiny, '--max-heap-mb', '0').stderr, /positive whole number/);
  });
});

describe('rea-studio analyze <website> (T021)', () => {
  const chrome = findChrome();
  it('captures a page served locally and maps its scripts and requests', { skip: chrome ? false : 'Chrome is not installed' }, async () => {
    // A tiny site on 127.0.0.1: one inline script and one external script that calls fetch().
    const server = createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><title>tiny</title><script>window.started = Date.now();</script><script src="/app.js"></script>');
      } else if (req.url === '/app.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end("fetch('/api/items').catch(() => {});");
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      const out = join(work, 'site.studio.json');
      const r = await runAsync('analyze', `http://127.0.0.1:${port}/`, '--out', out);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /\(web\)/);
      const project = JSON.parse(readFileSync(out, 'utf8')) as StudioProject;
      assert.equal(project.target.appKind, 'web');
      const paths = project.nodes.filter((n) => n.kind === 'file').map((n) => (n.kind === 'file' ? n.path : '')).sort();
      assert.deepEqual(paths, ['', '(inline script 1)', 'app.js']);
      assert.ok(project.nodes.some((n) => n.kind === 'endpoint' && n.value === '/api/items'));
    } finally {
      server.close();
    }
  });
});
