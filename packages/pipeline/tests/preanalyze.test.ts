import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir, truncate, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { preanalyzeFile, PreanalysisError } from '../src/preanalyze.js';
import { LocalStore, uploadKey, type ObjectStore } from '../src/storage.js';
import { MAX_UPLOAD_BYTES, type UploadRequest, type JobStatus } from '../src/contracts.js';
import type { UploadControl, PipelineConfig } from '../src/server.js';

const bytes = Buffer.from('public inert test file');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const projectId = 'a'.repeat(64);
type Control = Pick<UploadControl, 'config' | 'create' | 'complete' | 'status'>;
async function setup(t: import('node:test').TestContext) {
  const parent = resolve(import.meta.dirname, '../../../..');
  const root = await mkdtemp(join(parent, '.pipeline-test-'));
  t.after(async () => { assert.equal(dirname(root), parent); await rm(root, { recursive: true, force: true }); });
  const store = new LocalStore(join(root, 'objects'), 'b'.repeat(64));
  const config: PipelineConfig = { store, origin: 'http://localhost:3184', redisUrl: 'redis://localhost:6493', prefix: 'unit', workRoot: join(root, 'work') };
  const sourcePath = join(root, 'notes.elf');
  await writeFile(sourcePath, bytes);
  const id = randomUUID();
  let admissions = 0, completions = 0;
  const succeeded: JobStatus = { jobId: id, status: 'succeeded', projectId, cacheHit: false };
  const control: Control = {
    config,
    create: async value => {
      admissions++;
      assert.deepEqual(value, { name: 'notes.elf', bytes: bytes.length, sha256 });
      const signed = await store.signUpload(id, value as UploadRequest, config.origin);
      return { jobId: id, jobToken: 'c'.repeat(64), uploadUrl: signed.url, headers: signed.headers, expiresAt: new Date().toISOString() };
    },
    complete: async () => { completions++; assert.equal((await store.head(uploadKey(id, 'elf')))?.bytes, bytes.length); return succeeded; },
    status: async () => succeeded,
  };
  return { root, sourcePath, control, store, id, counts: () => ({ admissions, completions }) };
}

test('operator hashes exact bytes, checks a release digest and uses signed admission before queue completion', async t => {
  const { control, sourcePath, counts } = await setup(t);
  const seen: string[] = [];
  assert.deepEqual(await preanalyzeFile(control, { sourcePath, expectedSha256: sha256, onStatus: status => seen.push(status.status) }),
    { sha256, kind: 'elf', projectId, cacheHit: false });
  assert.deepEqual(counts(), { admissions: 1, completions: 1 });
  assert.deepEqual(seen, ['succeeded']);
});

test('a wrong release digest fails before admission or raw-object publication', async t => {
  const { control, sourcePath, root, counts } = await setup(t);
  await assert.rejects(preanalyzeFile(control, { sourcePath, expectedSha256: '0'.repeat(64) }),
    error => error instanceof PreanalysisError && error.stage === 'release digest verification');
  assert.deepEqual(counts(), { admissions: 0, completions: 0 });
  assert.deepEqual(await readdir(root), ['notes.elf']);
});

test('unsupported filenames, directories, invalid digests and oversized files fail before admission', async t => {
  const { control, sourcePath, root, counts } = await setup(t);
  const unsupported = join(root, 'notes.zip');
  const directory = join(root, 'folder.elf');
  const oversized = join(root, 'large.elf');
  await writeFile(unsupported, bytes);
  await mkdir(directory);
  await writeFile(oversized, '');
  await truncate(oversized, MAX_UPLOAD_BYTES + 1);
  for (const path of [unsupported, directory, oversized])
    await assert.rejects(preanalyzeFile(control, { sourcePath: path }), PreanalysisError);
  await assert.rejects(preanalyzeFile(control, { sourcePath, expectedSha256: 'not a digest' }), PreanalysisError);
  assert.deepEqual(counts(), { admissions: 0, completions: 0 });
});

test('file changes between hashing and transfer are rejected and unsubmitted bytes are cleaned', async t => {
  const { control, sourcePath, store, id, counts } = await setup(t);
  const create = control.create;
  control.create = async value => { const ticket = await create(value); await writeFile(sourcePath, Buffer.alloc(bytes.length)); return ticket; };
  await assert.rejects(preanalyzeFile(control, { sourcePath }), error => error instanceof PreanalysisError && error.stage === 'file upload');
  assert.equal(await store.head(uploadKey(id, 'elf')), null);
  assert.deepEqual(counts(), { admissions: 1, completions: 0 });
});

test('ambiguous completion failure preserves the input for a possibly queued worker', async t => {
  const { control, sourcePath, store, id } = await setup(t);
  control.complete = async () => { throw new Error('/private/path?token=secret'); };
  await assert.rejects(preanalyzeFile(control, { sourcePath }), error =>
    error instanceof PreanalysisError && error.stage === 'queue completion' && !error.message.includes('secret'));
  assert.ok(await store.head(uploadKey(id, 'elf')));
});

test('interrupting a stalled queue status stops waiting without deleting a queued input', async t => {
  const { control, sourcePath, store, id } = await setup(t);
  const abort = new AbortController();
  control.complete = async () => ({ jobId: id, status: 'queued' });
  control.status = async () => { abort.abort(); return await new Promise<JobStatus>(() => {}); };
  await assert.rejects(preanalyzeFile(control, { sourcePath, signal: abort.signal }), PreanalysisError);
  assert.ok(await store.head(uploadKey(id, 'elf')));
});

test('terminal analysis failures expose a stage without leaking private errors', async t => {
  const { control, sourcePath, id } = await setup(t);
  control.complete = async () => ({ jobId: id, status: 'failed', error: '/private/path?token=secret' });
  await assert.rejects(preanalyzeFile(control, { sourcePath }), error =>
    error instanceof PreanalysisError && error.stage === 'queued analysis' && !error.message.includes('secret'));
});

test('a completed status must include a valid project id and a cache receipt', async t => {
  const { control, sourcePath, id } = await setup(t);
  for (const status of [
    { jobId: id, status: 'succeeded', cacheHit: true },
    { jobId: id, status: 'succeeded', projectId: 'invalid', cacheHit: false },
    { jobId: id, status: 'succeeded', projectId },
  ] as JobStatus[]) {
    control.complete = async () => status;
    await assert.rejects(preanalyzeFile(control, { sourcePath }), error =>
      error instanceof PreanalysisError && error.stage === 'queued analysis');
  }
});

test('object upload streams bytes with their declared size and refuses redirects before queueing', async t => {
  const { control, sourcePath, store, id } = await setup(t);
  let redirect = false, uploaded = 0, deleted = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.method, 'PUT');
    assert.equal(req.headers['content-length'], String(bytes.length));
    assert.equal(req.headers['content-type'], 'application/octet-stream');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), bytes);
    uploaded++;
    res.writeHead(redirect ? 307 : 204, redirect ? { Location: 'http://untrusted.invalid/upload' } : {});
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const port = (server.address() as { port: number }).port;
  const objectStore: ObjectStore = {
    kind: 'r2', signUpload: (...args) => store.signUpload(...args), head: key => store.head(key), read: key => store.read(key),
    put: (...args) => store.put(...args), delete: async () => { deleted++; }, expireUploads: () => store.expireUploads(),
  };
  control.config.store = objectStore;
  control.create = async () => ({ jobId: id, jobToken: 'c'.repeat(64), uploadUrl: `http://127.0.0.1:${port}/upload`, headers: { 'Content-Type': 'application/octet-stream' }, expiresAt: '' });
  control.complete = async () => ({ jobId: id, status: 'succeeded', projectId, cacheHit: true });
  assert.equal((await preanalyzeFile(control, { sourcePath })).cacheHit, true);
  redirect = true;
  let complete = false;
  control.complete = async () => { complete = true; throw new Error('Must not queue.'); };
  await assert.rejects(preanalyzeFile(control, { sourcePath }), error => error instanceof PreanalysisError && error.stage === 'file upload');
  assert.equal(uploaded, 2);
  assert.equal(deleted, 1);
  assert.equal(complete, false);
});
