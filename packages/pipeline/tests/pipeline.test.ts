import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  utimes,
  mkdir,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { LocalStore, uploadKey, resultKey, R2Store } from '../src/storage.js';
import { validateUpload, MAX_UPLOAD_BYTES } from '../src/contracts.js';
import { processUpload, expireStaging } from '../src/processor.js';
import { UploadControl, type PipelineConfig, type UploadRecord } from '../src/server.js';
import { S3Client } from '@aws-sdk/client-s3';

const bytes = Buffer.from('inert archive fixture bytes');
const request = {
  name: 'tiny.asar',
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const projectId = 'b'.repeat(64);

test('fast completion between the job snapshot and state lookup returns the saved result', async () => {
  const r = record();
  const receipt = { projectId, resultKey: resultKey(r.sha256), uploadSha256: r.sha256, cacheHit: true };
  const stale = { getState: async () => 'completed', returnvalue: null };
  const fresh = { ...stale, returnvalue: receipt };
  // Exercise the API boundary without constructing real Redis connections.
  const control = Object.create(UploadControl.prototype) as UploadControl;
  let reads = 0;
  control.authorize = async () => r;
  Object.defineProperty(control, 'queue', { value: { getJob: async () => (++reads % 2 ? stale : fresh) } });
  Object.defineProperty(control, 'config', { value: { store: { read: async (key: string) => {
    assert.equal(key, receipt.resultKey);
    return Readable.from('normalized project');
  } } } });
  const status = await control.status(r.id, 'authorized by test');
  assert.equal(status.status, 'succeeded');
  assert.equal(status.cacheHit, true);
  assert.equal(status.projectId, projectId);
  assert.equal(status.uploadName, r.name);
  const stream = await control.project(r.id, 'authorized by test');
  assert.equal((await stream.toArray()).join(''), 'normalized project');
});

test('failure after the initial snapshot retains the final reason and progress', async () => {
  const r = record();
  const stale = { getState: async () => 'failed', failedReason: '', progress: 0 };
  const fresh = { ...stale, failedReason: 'Analysis failed (timeout).', progress: { phase: 'source', message: '17/38 sources' } };
  const control = Object.create(UploadControl.prototype) as UploadControl;
  let reads = 0;
  control.authorize = async () => r;
  Object.defineProperty(control, 'queue', { value: { getJob: async () => (++reads % 2 ? stale : fresh) } });
  const status = await control.status(r.id, 'authorized by test');
  assert.equal(status.errorCode, 'timeout');
  assert.equal(status.progress?.message, '17/38 sources');
});
const testRoot = resolve(import.meta.dirname, '../../../..');
async function setup(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(testRoot, '.pipeline-test-'));
  t.after(async () => {
    assert.equal(dirname(root), testRoot);
    await rm(root, { recursive: true, force: true });
  });
  const store = new LocalStore(join(root, 'objects'), 'a'.repeat(64));
  const config: PipelineConfig = {
    store,
    origin: 'http://localhost:3104',
    redisUrl: 'redis://localhost:6380',
    prefix: 'test',
    workRoot: join(root, 'work'),
  };
  return { root, store, config };
}
async function receive(store: LocalStore, r: UploadRecord, body = bytes) {
  const signed = await store.signUpload(r.id, r, 'http://localhost:3104');
  const u = new URL(signed.url);
  return store.receive(
    r.id,
    r,
    Number(u.searchParams.get('expires')),
    u.searchParams.get('signature')!,
    Readable.from(body),
  );
}
function record(): UploadRecord {
  return {
    ...request,
    id: randomUUID(),
    tokenHash: 'c'.repeat(64),
    createdAt: Date.now(),
  };
}

test('upload admission rejects hostile paths, wrong format, oversized files and malformed hashes', () => {
  assert.deepEqual(validateUpload(request), request);
  for (const patch of [
    { name: '../tiny.asar' },
    { name: 'tiny.exe' },
    { bytes: MAX_UPLOAD_BYTES + 1 },
    { bytes: 1.5 },
    { sha256: 'a' },
    { name: 'tiny\0.asar' },
  ])
    assert.throws(() => validateUpload({ ...request, ...patch }));
});
test('signed local uploads validate expiry, signature, size and SHA before publication', async (t) => {
  const { store } = await setup(t),
    r = record();
  await assert.rejects(
    store.receive(r.id, r, 1, 'a'.repeat(64), Readable.from(bytes)),
  );
  const signed = await store.signUpload(r.id, r, 'http://localhost:3104'),
    url = new URL(signed.url);
  await assert.rejects(
    store.receive(
      r.id,
      r,
      Number(url.searchParams.get('expires')),
      '0'.repeat(64),
      Readable.from(bytes),
    ),
  );
  await assert.rejects(receive(store, r, Buffer.concat([bytes, bytes])));
  await assert.rejects(receive(store, r, Buffer.alloc(bytes.length)));
  assert.equal(await store.head(uploadKey(r.id)), null);
  await receive(store, r);
  assert.equal((await store.head(uploadKey(r.id)))?.bytes, bytes.length);
});
test('processor verifies actual bytes, compresses normalized output, deduplicates and deletes raw uploads', async (t) => {
  const { config, store, root } = await setup(t);
  let calls = 0;
  const normalized = JSON.stringify({ id: projectId, schemaVersion: '0.1.0' });
  const analyze = async ({ targetName }: { outputRoot: string; targetName: string }) => {
    assert.equal(targetName, 'target.asar');
    calls++;
    const path = join(root, `result-${calls}.json`);
    await writeFile(path, normalized);
    return { projectPath: path, projectId };
  };
  for (const cached of [false, true]) {
    const r = record();
    r.name = cached ? 'second-user-label.asar' : 'first-user-label.asar';
    await receive(store, r);
    const result = await processUpload(
      config,
      { data: r, updateProgress: async () => {} },
      analyze,
    );
    assert.equal(result.cacheHit, cached);
    assert.equal(result.uploadSha256, request.sha256);
    assert.equal(await store.head(uploadKey(r.id)), null);
  }
  assert.equal(calls, 1);
  const chunks: Buffer[] = [];
  for await (const chunk of await store.read(resultKey(request.sha256)))
    chunks.push(Buffer.from(chunk));
  assert.equal(gunzipSync(Buffer.concat(chunks)).toString(), normalized);
  assert.deepEqual(await readdir(config.workRoot), []);
});
test('claimed cache hash cannot bypass byte verification; failure removes raw and staging', async (t) => {
  const { config, store, root } = await setup(t),
    r = record();
  // Tamper with a finalized local object to exercise the worker trust boundary.
  await receive(store, r);
  await writeFile(
    join(root, 'objects', uploadKey(r.id)),
    Buffer.alloc(bytes.length),
  );
  let called = false;
  await assert.rejects(
    processUpload(
      config,
      { data: r, updateProgress: async () => {} },
      async () => {
        called = true;
        throw new Error('should not run');
      },
    ),
  );
  assert.equal(called, false);
  assert.equal(await store.head(uploadKey(r.id)), null);
  assert.deepEqual(await readdir(config.workRoot), []);
});
test('analysis failures expose no internal paths or secrets and publish no result', async (t) => {
  const { config, store } = await setup(t),
    r = record();
  await receive(store, r);
  await assert.rejects(
    processUpload(
      config,
      { data: r, updateProgress: async () => {} },
      async () => {
        throw new Error('/private/path?secret=token');
      },
    ),
    (error) =>
      error instanceof Error &&
      !error.message.includes('private') &&
      !error.message.includes('secret'),
  );
  assert.equal(await store.head(resultKey(r.sha256)), null);
  assert.equal(await store.head(uploadKey(r.id)), null);
});
test('expiry sweep removes old uploads and retains fresh objects', async (t) => {
  const { store, root } = await setup(t),
    old = record(),
    fresh = record();
  await receive(store, old);
  await receive(store, fresh);
  await utimes(
    join(root, 'objects', uploadKey(old.id)),
    new Date(0),
    new Date(0),
  );
  await store.expireUploads();
  assert.equal(await store.head(uploadKey(old.id)), null);
  assert.ok(await store.head(uploadKey(fresh.id)));
});
test('R2 upload signature binds object key, type, length, and a ten-minute expiry without contacting R2', async () => {
  const client = new S3Client({
    region: 'auto',
    endpoint: 'https://account.r2.cloudflarestorage.com',
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: 'test', secretAccessKey: 'not-a-real-key' },
  });
  const store = new R2Store(client, 'private-bucket'),
    id = randomUUID(),
    ticket = await store.signUpload(id, request, 'https://studio.example');
  const url = new URL(ticket.url);
  assert.ok(url.pathname.endsWith(uploadKey(id)));
  assert.equal(url.searchParams.get('X-Amz-Expires'), '600');
  const signed = url.searchParams.get('X-Amz-SignedHeaders')!;
  assert.match(signed, /content-length/u);
  assert.match(signed, /content-type/u);
  client.destroy();
});
test('expired queued uploads never reach analysis and are removed', async (t) => {
  const { config, store } = await setup(t),
    r = record();
  await receive(store, r);
  r.createdAt = 0;
  let called = false;
  await assert.rejects(
    processUpload(
      config,
      { data: r, updateProgress: async () => {} },
      async () => {
        called = true;
        throw new Error('should not run');
      },
    ),
    /upload_expired/u,
  );
  assert.equal(called, false);
  assert.equal(await store.head(uploadKey(r.id)), null);
});
test('staging expiry removes only old directories with the private upload prefix', async (t) => {
  const { config } = await setup(t);
  await mkdir(config.workRoot, { recursive: true });
  const old = join(config.workRoot, 'upload-old'),
    fresh = join(config.workRoot, 'upload-fresh'),
    unrelated = join(config.workRoot, 'keep-me');
  for (const path of [old, fresh, unrelated]) await mkdir(path);
  await utimes(old, new Date(0), new Date(0));
  await utimes(unrelated, new Date(0), new Date(0));
  await expireStaging(config.workRoot);
  assert.deepEqual((await readdir(config.workRoot)).sort(), [
    'keep-me',
    'upload-fresh',
  ]);
});
