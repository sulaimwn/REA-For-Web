import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { adaptReaFile, extractedArtifactRoot } from '../src/file.js';
import { adaptReaResult, ReaOutputError } from '../src/index.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixture = join(repo, 'fixtures/samples/tiny-electron.rea-6.4.0.json');
const options = { reaVersion: '6.4.0', maxBytes: 128 * 1024 * 1024 };

test('bounded file boundary yields the real fixture project and adapter report', async () => {
  const expected = adaptReaResult(JSON.parse(await readFile(fixture, 'utf8')), options);
  assert.deepEqual(await adaptReaFile(fixture, options), expected);
});

test('file boundary rejects a byte cap before parsing', async () => {
  await assert.rejects(adaptReaFile(fixture, { ...options, maxBytes: 16 }), ReaOutputError);
  await assert.rejects(adaptReaFile(fixture, { ...options, maxBytes: 0 }), ReaOutputError);
});

test('file boundary rejects invalid JSON, UTF-8, and directory artifacts', async t => {
  const temp = await mkdtemp(join(repo, '.worker-test-'));
  t.after(async () => {
    assert.equal(dirname(temp), repo);
    await rm(temp, { recursive: true, force: true });
  });
  const path = join(temp, 'result.json');
  for (const bytes of [Buffer.from('not JSON'), Buffer.from([0xff, 0xfe])]) {
    await writeFile(path, bytes);
    await assert.rejects(adaptReaFile(path, options), ReaOutputError);
  }
  await assert.rejects(adaptReaFile(temp, options));
});

test('unsupported IPC or endpoint values stay visible as gaps instead of guessed facts', async () => {
  const raw = JSON.parse(await readFile(fixture, 'utf8'));
  const desktop = JSON.parse(await readFile(join(repo, 'fixtures/samples/github-desktop-3.6.5.trimmed.rea-6.4.0.json'), 'utf8'));
  for (const [kind, property, value] of [
    ['ipc-handler', 'side', 'future-side'],
    ['ipc-handler', 'operation', 'future-operation'],
    ['ipc-channel', 'side', 'future-side'],
    ['ipc-channel', 'operation', 'future-operation'],
    ['ipc-channel', 'resolution', 'future-resolution'],
    ['endpoint', 'endpoint_kind', 'future-endpoint'],
  ]) {
    const changed = structuredClone(kind === 'endpoint' ? desktop : raw);
    const node = changed.normalized_result.graph.nodes.find((n: { kind: string }) => n.kind === kind);
    assert.ok(node, `fixture must cover ${kind}`);
    for (const observation of node.observations) observation.properties[property!] = value;
    const { project, report } = adaptReaResult(changed, options);
    assert.equal(project.nodes.find(n => n.id === node.node_id)?.kind, 'analysis-gap', `${kind}/${property}`);
    assert.equal(report.unrecognizedNodeKinds[kind!], 1);
  }
});

test('malformed digests are rejected at the adapter boundary', async () => {
  const raw = JSON.parse(await readFile(fixture, 'utf8'));
  raw.subject.digest.sha256 = '../invalid-cache-key';
  assert.throws(() => adaptReaResult(raw, options), ReaOutputError);
});

test('extraction cleanup accepts only REA folders directly under the system temp directory', async t => {
  const temp = await mkdtemp(join(repo, '.worker-test-'));
  t.after(async () => {
    assert.equal(dirname(temp), repo);
    await rm(temp, { recursive: true, force: true });
  });
  const path = join(temp, 'extraction.json');
  const valid = join(tmpdir(), 'rea-extracted-review-example');
  await writeFile(path, JSON.stringify({ operation: 'extract_artifact', parameters: { output_root: valid } }));
  assert.equal(await extractedArtifactRoot(path, options.maxBytes), valid);
  for (const root of [join(repo, 'rea-extracted-other'), join(tmpdir(), 'nested', 'rea-extracted-other'), tmpdir()]) {
    await writeFile(path, JSON.stringify({ operation: 'extract_artifact', parameters: { output_root: root } }));
    await assert.rejects(extractedArtifactRoot(path, options.maxBytes), ReaOutputError);
  }
  await assert.rejects(extractedArtifactRoot(path, 1), ReaOutputError);
});
