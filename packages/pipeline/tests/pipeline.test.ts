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
import { validateUpload, MAX_UPLOAD_BYTES, UPLOAD_KINDS, UPLOAD_EXTENSIONS, UPLOAD_ACCEPT, uploadKind } from '../src/contracts.js';
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
test('a queue progress timeout offers a retry without exposing internal details', async () => {
  const r = record();
  const job = { getState: async () => 'failed', failedReason: 'Analysis failed (progress_unavailable).', progress: { phase: 'source', message: '17/38 sources' } };
  const control = Object.create(UploadControl.prototype) as UploadControl;
  control.authorize = async () => r;
  Object.defineProperty(control, 'queue', { value: { getJob: async () => job } });
  const status = await control.status(r.id, 'authorized by test');
  assert.equal(status.status, 'failed');
  assert.match(status.error!, /queue connection/u);
  assert.match(status.error!, /upload it again/u);
  assert.doesNotMatch(status.error!, /progress_unavailable/u);
  assert.equal(status.progress?.message, '17/38 sources');
});

test('size, memory and result limits read as plain messages, not internal codes (T057)', async () => {
  const r = record();
  for (const [code, text] of [['input_limit_exceeded', /larger than this server accepts/u],
    ['out_of_memory', /more memory than one analysis is allowed/u], ['output_limit_exceeded', /larger than the result limit/u]] as const) {
    const job = { getState: async () => 'failed', failedReason: `Analysis failed (${code}).`, progress: 0 };
    const control = Object.create(UploadControl.prototype) as UploadControl;
    control.authorize = async () => r;
    Object.defineProperty(control, 'queue', { value: { getJob: async () => job } });
    const status = await control.status(r.id, 'authorized by test');
    assert.match(status.error!, text);
    assert.doesNotMatch(status.error!, new RegExp(code, 'u'));
  }
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
  for (const kind of UPLOAD_KINDS) {
    const value = { ...request, name: `tiny.${kind.toUpperCase()}`, native: true };
    assert.equal(uploadKind(validateUpload(value).name), kind);
    assert.equal('native' in validateUpload(value), false, 'only accepted upload fields are retained');
  }
  for (const patch of [
    { name: '../tiny.asar' },
    { name: 'tiny.zip' },
    { name: 'tiny-notes' },
    { name: 'libnotes.so.1' },
    { name: 'Notes.app' },
    { name: 'Notes.ipa' },
    { name: 'libnotes.dylib.1' },
    { bytes: MAX_UPLOAD_BYTES + 1 },
    { bytes: 1.5 },
    { sha256: 'a' },
    { name: 'tiny\0.asar' },
  ])
    assert.throws(() => validateUpload({ ...request, ...patch }));
});
test('ELF and shared-library filename aliases use the same analysis kind and file picker', () => {
  for (const name of ['tiny.elf', 'libnotes.so', 'libnotes.SO']) {
    assert.equal(uploadKind(validateUpload({ ...request, name }).name), 'elf');
  }
  assert.equal(UPLOAD_ACCEPT, '.asar,.exe,.dll,.apk,.elf,.so,.macho,.dylib');
});

test('Mach-O and dylib aliases use the same analysis kind, without admitting bundles or bare names', () => {
  for (const name of ['jq.macho', 'jq.MACHO', 'libnotes.dylib', 'libnotes.DYLIB']) {
    assert.equal(uploadKind(validateUpload({ ...request, name }).name), 'macho');
  }
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

test('program kinds reach the runner with their extension, partition caches, and clean raw uploads', async (t) => {
  const { config, store, root } = await setup(t);
  let calls = 0;
  for (const kind of UPLOAD_KINDS) {
    for (const cached of [false, true]) {
      const r = { ...record(), name: `label.${kind}` };
      await receive(store, r);
      const result = await processUpload(config, { data: r, updateProgress: async () => {} }, async ({ targetPath, targetName }) => {
        assert.equal(targetName, `target.${kind}`);
        assert.ok(targetPath.endsWith(`target.${kind}`));
        assert.deepEqual(await readFile(targetPath), bytes);
        calls++;
        const projectPath = join(root, `normalized-${calls}.json`);
        await writeFile(projectPath, JSON.stringify({ id: projectId, kind }));
        return { projectPath, projectId };
      });
      assert.equal(result.cacheHit, cached);
      assert.equal(result.resultKey, resultKey(r.sha256, kind));
      assert.equal(await store.head(uploadKey(r.id, kind)), null);
      assert.deepEqual(await readdir(config.workRoot), []);
    }
  }
  assert.equal(calls, UPLOAD_KINDS.length, 'the same bytes under a different kind must be analyzed again');
});

test('ELF aliases deduplicate only after verified bytes, retain canonical staging, and clean raw uploads', async (t) => {
  const { config, store, root } = await setup(t);
  let calls = 0;
  const analyze = async ({ targetPath, targetName }: { targetPath: string; targetName: string }) => {
    assert.equal(targetName, 'target.elf');
    assert.ok(targetPath.endsWith('target.elf'));
    assert.deepEqual(await readFile(targetPath), bytes);
    calls++;
    const projectPath = join(root, 'elf-result.json');
    await writeFile(projectPath, JSON.stringify({ id: projectId }));
    return { projectPath, projectId };
  };
  for (const [name, cached] of [['notes.elf', false], ['libnotes.SO', true]] as const) {
    const r = { ...record(), name };
    await receive(store, r);
    const result = await processUpload(config, { data: r, updateProgress: async () => {} }, analyze);
    assert.equal(result.cacheHit, cached);
    assert.equal(result.resultKey, resultKey(r.sha256, 'elf'));
    assert.equal(await store.head(uploadKey(r.id, 'elf')), null);
  }
  const tampered = { ...record(), name: 'tampered.so' };
  await receive(store, tampered);
  await writeFile(join(root, 'objects', uploadKey(tampered.id, 'elf')), Buffer.alloc(bytes.length));
  await assert.rejects(processUpload(config, { data: tampered, updateProgress: async () => {} }, analyze));
  assert.equal(calls, 1, 'cache reuse must not bypass possession verification for either alias');
  assert.equal(await store.head(uploadKey(tampered.id, 'elf')), null);
  assert.deepEqual(await readdir(config.workRoot), []);
});

test('renaming a cached artifact cannot bypass the new kind’s parser or publish a result', async (t) => {
  const { config, store, root } = await setup(t);
  const existing = record();
  await receive(store, existing);
  await processUpload(config, { data: existing, updateProgress: async () => {} }, async () => {
    const projectPath = join(root, 'cached.json');
    await writeFile(projectPath, '{}');
    return { projectPath, projectId };
  });
  for (const name of ['renamed.exe', 'renamed.elf', 'renamed.so', 'renamed.macho', 'renamed.dylib']) {
    const renamed = { ...record(), name }, kind = uploadKind(name)!;
    await receive(store, renamed);
    let analyzed = false;
    await assert.rejects(processUpload(config, { data: renamed, updateProgress: async () => {} }, async () => {
      analyzed = true;
      throw Object.assign(new Error('invalid binary'), { code: 'invalid_input' });
    }), /invalid_input/);
    assert.equal(analyzed, true);
    assert.equal(await store.head(resultKey(renamed.sha256, kind)), null);
    assert.equal(await store.head(uploadKey(renamed.id, kind)), null);
  }
  assert.deepEqual(await readdir(config.workRoot), []);
});

test('Mach-O alias cache hits require verified bytes, canonical staging and raw cleanup', async (t) => {
  const { config, store, root } = await setup(t);
  let calls = 0;
  const analyze = async ({ targetPath, targetName }: { targetPath: string; targetName: string }) => {
    assert.equal(targetName, 'target.macho');
    assert.ok(targetPath.endsWith('target.macho'));
    assert.deepEqual(await readFile(targetPath), bytes);
    calls++;
    const projectPath = join(root, 'macho-result.json');
    await writeFile(projectPath, JSON.stringify({ id: projectId }));
    return { projectPath, projectId };
  };
  for (const [name, cached] of [['jq.macho', false], ['libjq.DYLIB', true]] as const) {
    const r = { ...record(), name };
    await receive(store, r);
    const result = await processUpload(config, { data: r, updateProgress: async () => {} }, analyze);
    assert.equal(result.cacheHit, cached);
    assert.equal(result.resultKey, resultKey(r.sha256, 'macho'));
    assert.equal(await store.head(uploadKey(r.id, 'macho')), null);
  }
  // Bypass the local PUT verifier to exercise the same worker boundary as R2.
  const tampered = { ...record(), name: 'tampered.dylib' };
  await receive(store, tampered);
  await writeFile(join(root, 'objects', uploadKey(tampered.id, 'macho')), Buffer.alloc(bytes.length));
  let cacheReads = 0;
  const head = store.head.bind(store);
  store.head = async (key) => { cacheReads++; return head(key); };
  await assert.rejects(processUpload(config, { data: tampered, updateProgress: async () => {} }, analyze));
  assert.equal(cacheReads, 0, 'SHA verification must finish before even looking for a cached result');
  assert.equal(calls, 1);
  assert.equal(await head(uploadKey(tampered.id, 'macho')), null);
  assert.deepEqual(await readdir(config.workRoot), []);
});

test('old authorized ASAR result paths remain readable after the cache revision changes', async (t) => {
  const { store, root } = await setup(t);
  const file = join(root, 'saved-result.json.gz');
  await writeFile(file, 'saved bytes');
  for (const version of [2, 3, 4, 5, 6]) {
    const key = `results/schema-0.1.0-rea-6.4.0-adapter-${version}/${request.sha256}.json.gz`;
    await store.put(key, file, {});
    assert.equal((await (await store.read(key)).toArray()).join(''), 'saved bytes');
  }
  // Both previously published engine namespaces stay readable after the 6.7 upgrade.
  for (const kind of ['asar', 'exe', 'dll', 'apk', 'elf', 'macho'] as const) {
    const key = `results/schema-0.1.0-rea-6.4.0-adapter-7/${kind}/${request.sha256}.json.gz`;
    await store.put(key, file, {});
    assert.equal((await (await store.read(key)).toArray()).join(''), 'saved bytes');
    const previous = `results/schema-0.1.0-rea-6.5.0-adapter-8/${kind}/${request.sha256}.json.gz`;
    await store.put(previous, file, {});
    assert.equal((await (await store.read(previous)).toArray()).join(''), 'saved bytes');
    assert.match(resultKey(request.sha256, kind), new RegExp(`^results/schema-0\\.1\\.0-rea-6\\.7\\.0-adapter-9/${kind}/`, 'u'));
  }
  await assert.rejects(store.read(`results/schema-0.1.0-rea-6.5.0-adapter-7/asar/${request.sha256}.json.gz`), /Invalid storage key/u);
  await assert.rejects(store.read(`results/schema-0.1.0-rea-6.7.0-adapter-8/asar/${request.sha256}.json.gz`), /Invalid storage key/u);
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
test('a stalled progress write cannot indefinitely retain a failed upload', { timeout: 8000 }, async (t) => {
  const { config, store } = await setup(t), r = record();
  await receive(store, r);
  let writes = 0;
  await assert.rejects(processUpload(config, {
    data: r,
    updateProgress: async () => {
      writes++;
      // Redis can keep an offline progress command pending while reconnecting.
      await new Promise<void>(() => {});
    },
  }, async ({ onProgress }) => {
    onProgress({ phase: 'source', message: 'Parsing source 17/38' });
    throw Object.assign(new Error('/private/target?secret=token'), { code: 'timeout' });
  }), /Analysis failed \(timeout\)\./u);
  assert.equal(writes, 1);
  assert.equal(await store.head(uploadKey(r.id)), null);
  assert.equal(await store.head(resultKey(r.sha256)), null);
  assert.deepEqual(await readdir(config.workRoot), []);
});

test('a stalled progress write prevents result publication and bounds the queued backlog', { timeout: 8000 }, async (t) => {
  const { config, store, root } = await setup(t), r = record();
  await receive(store, r);
  let writes = 0;
  await assert.rejects(processUpload(config, {
    data: r,
    updateProgress: async () => {
      writes++;
      await new Promise<void>(() => {});
    },
  }, async ({ onProgress }) => {
    for (let n = 0; n < 100; n++) onProgress({ phase: 'source', message: `Parsing source ${n}/100` });
    const projectPath = join(root, 'normalized.json');
    await writeFile(projectPath, JSON.stringify({ id: projectId }));
    return { projectPath, projectId };
  }), /Analysis failed \(progress_unavailable\)\./u);
  assert.equal(writes, 1, 'a timed-out Redis write must not enqueue its backlog');
  assert.equal(await store.head(resultKey(r.sha256)), null);
  assert.equal(await store.head(uploadKey(r.id)), null);
  assert.deepEqual(await readdir(config.workRoot), []);
});

test('expiry sweep removes old uploads and retains fresh objects', async (t) => {
  const { store, root } = await setup(t),
    old = record(),
    fresh = record();
  await receive(store, old);
  await receive(store, fresh);
  for (const kind of UPLOAD_KINDS) {
    const r = { ...old, name: `expired.${kind}` };
    await receive(store, r);
    await utimes(join(root, 'objects', uploadKey(r.id, kind)), new Date(0), new Date(0));
  }
  const partial = join(root, 'objects', `${uploadKey(old.id, 'macho')}.${randomUUID()}.partial`);
  await writeFile(partial, bytes);
  await utimes(partial, new Date(0), new Date(0));
  await store.expireUploads();
  assert.equal(await store.head(uploadKey(old.id)), null);
  for (const kind of UPLOAD_KINDS) assert.equal(await store.head(uploadKey(old.id, kind)), null);
  assert.ok(await store.head(uploadKey(fresh.id)));
  assert.deepEqual(await readdir(join(root, 'objects', 'uploads')), [`${fresh.id}.asar`]);
});
test('R2 upload signature binds object key, type, length, and a ten-minute expiry without contacting R2', async () => {
  const client = new S3Client({
    region: 'auto',
    endpoint: 'https://account.r2.cloudflarestorage.com',
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: 'test', secretAccessKey: 'not-a-real-key' },
  });
  const store = new R2Store(client, 'private-bucket'), id = randomUUID();
  for (const extension of UPLOAD_EXTENSIONS) {
    const kind = uploadKind(`app.${extension}`)!;
    const ticket = await store.signUpload(id, { ...request, name: `app.${extension}` }, 'https://studio.example');
    const url = new URL(ticket.url);
    assert.ok(url.pathname.endsWith(uploadKey(id, kind)));
    assert.equal(url.searchParams.get('X-Amz-Expires'), '600');
    const signed = url.searchParams.get('X-Amz-SignedHeaders')!;
    assert.match(signed, /content-length/u);
    assert.match(signed, /content-type/u);
  }
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
