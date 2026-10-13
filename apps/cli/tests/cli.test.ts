import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { STUDIO_SCHEMA_VERSION, type StudioProject } from '@rea-studio/schema';

// Compiled to dist-tests/tests/; the built CLI is dist/cli.js and the repo root is four levels up.
const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const tiny = fileURLToPath(new URL('../../../../fixtures/sample-apps/tiny-electron', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'rea-studio-cli-test-'));
after(() => rmSync(work, { recursive: true, force: true }));

const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, INIT_CWD: work }, timeout: 300_000 });

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
    assert.equal(project.analysis.engine.version, '6.4.0');
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
    assert.match(wrong.stderr, /directory or an \.asar file/);
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
