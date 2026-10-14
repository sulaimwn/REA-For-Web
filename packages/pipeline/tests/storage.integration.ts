// Real SDK requests to an isolated loopback HTTP service; no cloud credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { S3Client } from '@aws-sdk/client-s3';
import { R2Store, resultKey, uploadKey } from '../src/storage.js';
import { processUpload } from '../src/processor.js';
import type { PipelineConfig, UploadRecord } from '../src/server.js';

const testRoot = resolve(import.meta.dirname, '../../../..');
const bytes = Buffer.from('inert storage fixture');
const record = (): UploadRecord => ({
  name: 'tiny.asar', bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  id: randomUUID(), tokenHash: 'c'.repeat(64), createdAt: Date.now(),
});

async function setup(t: import('node:test').TestContext, handler: RequestListener, maxAttempts = 1, deadlineMs = 500) {
  const root = await mkdtemp(join(testRoot, '.pipeline-test-'));
  const server = createServer(handler);
  const clients: S3Client[] = [];
  t.after(async () => {
    for (const client of clients) client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(dirname(root), testRoot);
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${address.port}`, region: 'auto', forcePathStyle: true,
    maxAttempts,
    ...(maxAttempts > 1 ? {
      // Force a long SDK backoff so an abort signal alone cannot satisfy the
      // caller deadline. Only our cancellation race can settle during sleep.
      retryStrategy: {
        mode: 'standard',
        async acquireInitialRetryToken() {
          return { getRetryCount: () => 0, getRetryDelay: () => 0, getRetryCost: () => 1 };
        },
        async refreshRetryTokenForRetry(token: { getRetryCount(): number }, info: { error?: Error }) {
          if (info.error?.name === 'AbortError' || token.getRetryCount() >= maxAttempts - 1)
            throw info.error ?? new Error('Retry budget exhausted.');
          const count = token.getRetryCount() + 1;
          return { getRetryCount: () => count, getRetryDelay: () => 2000, getRetryCost: () => 1 };
        },
        recordSuccess() {},
      },
    } : {}),
    credentials: { accessKeyId: 'inert-test-key', secretAccessKey: 'inert-test-secret' },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    // Reproduce the installed SDK's warning-only timeout. The store must still
    // cancel the complete operation, without relying on this per-attempt timer.
    requestHandler: { connectionTimeout: 100, requestTimeout: 50 },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  clients.push(client);
  const store = new R2Store(client, 'test', deadlineMs);
  const config: PipelineConfig = {
    store, redisUrl: 'redis://localhost:1', prefix: 'storage-test',
    origin: 'http://localhost:1', workRoot: join(root, 'work'),
  };
  return { root, store, config };
}

test('stalled HEAD, GET, PUT, DELETE and LIST requests abort instead of only warning', { timeout: 10000 }, async (t) => {
  const calls: string[] = [];
  const { root, store } = await setup(t, (req) => { calls.push(`${req.method} ${req.url?.split('?')[0]}`); req.resume(); });
  const r = record(), path = join(root, 'project.json.gz');
  await writeFile(path, 'inert result bytes');
  for (const operation of [
    () => store.head(resultKey(r.sha256)),
    () => store.read(uploadKey(r.id)),
    () => store.put(resultKey(r.sha256), path, {}),
    () => store.delete(uploadKey(r.id)),
    () => store.expireUploads(),
  ]) {
    const start = Date.now();
    await assert.rejects(operation(), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'storage_unavailable');
    assert.ok(Date.now() - start < 2500, 'operation must settle even when the service never replies');
  }
  assert.deepEqual(calls.map(value => value.split(' ')[0]), ['HEAD', 'GET', 'PUT', 'DELETE', 'GET']);
  await rm(path); // The failed PUT must release the local source file.
});

test('the storage deadline includes retries and backoff', { timeout: 5000 }, async (t) => {
  let attempts = 0;
  const { store } = await setup(t, (_req, res) => {
    attempts++;
    res.writeHead(503, { 'Content-Type': 'application/xml' });
    res.end('<Error><Code>SlowDown</Code><Message>Try later</Message></Error>');
  }, 10);
  const start = Date.now();
  await assert.rejects(store.head(resultKey('a'.repeat(64))), /storage request timed out/u);
  assert.equal(attempts, 1, 'a retry sleeping past the deadline must not send another request');
  assert.ok(Date.now() - start < 1000, 'settle during the two-second retry sleep');
  await delay(2100);
  assert.equal(attempts, 1, 'cancellation must also prevent a delayed request after returning');
});

test('GET headers and partial bodies retain the deadline; streamed results recover afterward', { timeout: 5000 }, async (t) => {
  let mode: 'headers' | 'partial' | 'normal' = 'headers';
  let closed = 0;
  const { store } = await setup(t, (req, res) => {
    req.resume();
    res.on('close', () => { closed++; });
    res.writeHead(200, { 'Content-Length': bytes.length });
    res.flushHeaders();
    if (mode === 'partial') res.write(bytes.subarray(0, 3));
    if (mode === 'normal') res.end(bytes);
  });
  for (const next of ['headers', 'partial'] as const) {
    mode = next;
    const start = Date.now();
    const body = await store.read(resultKey('a'.repeat(64)));
    let received = 0;
    const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { received += chunk.length; callback(); } });
    await assert.rejects(pipeline(body, sink), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'storage_unavailable');
    assert.ok(Date.now() - start < 1500, 'the stream must settle without a separate consumer timeout');
    assert.equal(received, next === 'partial' ? 3 : 0);
    assert.equal(body.destroyed, true);
  }
  // The actual web route adapts the stored gzip stream with Readable.toWeb.
  // Consume that same Web-stream boundary after recovery, using the same client.
  mode = 'normal';
  const { Readable } = await import('node:stream');
  const body = await store.read(resultKey('a'.repeat(64)));
  assert.deepEqual(Buffer.from(await new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>).arrayBuffer()), bytes);
  assert.ok(closed >= 2, 'timed-out GETs release their HTTP connections');
});

test('a result Web stream reports the same sanitized storage deadline after partial bytes', { timeout: 5000 }, async (t) => {
  const { store } = await setup(t, (req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Length': bytes.length });
    res.write(bytes.subarray(0, 3));
  });
  const { Readable } = await import('node:stream');
  const body = await store.read(resultKey('a'.repeat(64)));
  await assert.rejects(new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>).arrayBuffer(), (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === 'storage_unavailable' &&
    error.message === 'Object storage request timed out.');
});

test('GET body consumption shares the original deadline with delayed headers', { timeout: 5000 }, async (t) => {
  const { store } = await setup(t, (req, res) => {
    req.resume();
    void delay(600).then(() => {
      if (!res.destroyed) {
        res.writeHead(200, { 'Content-Length': bytes.length });
        res.write(bytes.subarray(0, 3));
      }
    });
  }, 1, 800);
  const start = Date.now();
  const body = await store.read(resultKey('a'.repeat(64)));
  assert.ok(Date.now() - start >= 550, 'headers really consumed most of the deadline');
  await assert.rejects(pipeline(body, new Writable({ write(_chunk, _encoding, callback) { callback(); } })),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'storage_unavailable');
  assert.ok(Date.now() - start < 1150, 'GET must not start a fresh 800ms deadline after headers');
});

test('a stalled upload body cleans raw data and staging, then the processor recovers', { timeout: 5000 }, async (t) => {
  let stalled = true, analyzed = 0, deletions = 0, puts = 0;
  const { config } = await setup(t, (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Length': bytes.length });
      if (stalled) res.write(bytes.subarray(0, 3));
      else res.end(bytes);
    }
    if (req.method === 'HEAD') { res.writeHead(404); res.end(); }
    if (req.method === 'DELETE') { deletions++; res.writeHead(204); res.end(); }
    if (req.method === 'PUT') {
      puts++; req.resume(); req.on('end', () => { res.writeHead(200); res.end(); });
    }
  });
  const analyze = async ({ outputRoot }: { outputRoot: string }) => {
    analyzed++;
    const projectPath = join(dirname(outputRoot), 'normalized.json'), projectId = 'b'.repeat(64);
    await writeFile(projectPath, JSON.stringify({ id: projectId }));
    return { projectPath, projectId };
  };
  await assert.rejects(processUpload(config, { data: record(), updateProgress: async () => {} }, analyze),
    /^Error: Analysis failed \(storage_unavailable\)\.$/u);
  assert.equal(analyzed, 0);
  assert.equal(puts, 0);
  assert.equal(deletions, 1);
  assert.deepEqual(await readdir(config.workRoot), []);
  stalled = false;
  const result = await processUpload(config, { data: record(), updateProgress: async () => {} }, analyze);
  assert.equal(result.cacheHit, false);
  assert.equal(analyzed, 1);
  assert.equal(puts, 1);
  assert.equal(deletions, 2);
  assert.deepEqual(await readdir(config.workRoot), []);
});

test('a stalled cache lookup stops analysis and deletes raw data and staging', { timeout: 5000 }, async (t) => {
  let deletions = 0, analyzed = false;
  const { config } = await setup(t, (req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes); }
    if (req.method === 'DELETE') { deletions++; res.writeHead(204); res.end(); }
  });
  await assert.rejects(processUpload(config, { data: record(), updateProgress: async () => {} }, async () => {
    analyzed = true;
    throw new Error('should not reach analysis');
  }), /^Error: Analysis failed \(storage_unavailable\)\.$/u);
  assert.equal(analyzed, false);
  assert.equal(deletions, 1);
  assert.deepEqual(await readdir(config.workRoot), []);
});

test('a stalled raw deletion still releases local staging and fails the job', { timeout: 5000 }, async (t) => {
  let deletions = 0;
  const { config } = await setup(t, (req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes); }
    if (req.method === 'HEAD') { res.writeHead(404); res.end(); }
    if (req.method === 'DELETE') deletions++;
  });
  await assert.rejects(processUpload(config, { data: record(), updateProgress: async () => {} }, async () => {
    throw Object.assign(new Error('/private/path?secret=token'), { code: 'invalid_input' });
  }), /^Error: Raw upload cleanup failed\.$/u);
  assert.equal(deletions, 1);
  assert.deepEqual(await readdir(config.workRoot), []);
});

test('a stalled result PUT yields no successful job receipt and cleans raw and staging', { timeout: 5000 }, async (t) => {
  let deletions = 0, puts = 0;
  const { config } = await setup(t, (req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes); }
    if (req.method === 'HEAD') { res.writeHead(404); res.end(); }
    if (req.method === 'PUT') { puts++; req.resume(); }
    if (req.method === 'DELETE') { deletions++; res.writeHead(204); res.end(); }
  });
  await assert.rejects(processUpload(config, { data: record(), updateProgress: async () => {} }, async ({ outputRoot }) => {
    const projectPath = join(dirname(outputRoot), 'normalized.json');
    const projectId = 'b'.repeat(64);
    await writeFile(projectPath, JSON.stringify({ id: projectId }));
    return { projectPath, projectId };
  }), /^Error: Analysis failed \(storage_unavailable\)\.$/u);
  assert.equal(puts, 1);
  assert.equal(deletions, 1);
  assert.deepEqual(await readdir(config.workRoot), []);
});

test('normal storage responses still support verified analysis and result publication', { timeout: 5000 }, async (t) => {
  let resultBytes = 0, deletions = 0;
  const { config } = await setup(t, (req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes); }
    if (req.method === 'HEAD') { res.writeHead(404); res.end(); }
    if (req.method === 'PUT') {
      req.on('data', (chunk: Buffer) => { resultBytes += chunk.length; });
      req.on('end', () => { res.writeHead(200); res.end(); });
    }
    if (req.method === 'DELETE') { deletions++; res.writeHead(204); res.end(); }
  });
  const result = await processUpload(config, { data: record(), updateProgress: async () => {} }, async ({ outputRoot }) => {
    const projectPath = join(dirname(outputRoot), 'normalized.json'), projectId = 'b'.repeat(64);
    await writeFile(projectPath, JSON.stringify({ id: projectId }));
    return { projectPath, projectId };
  });
  assert.equal(result.projectId, 'b'.repeat(64));
  assert.equal(result.cacheHit, false);
  assert.ok(resultBytes > 0);
  assert.equal(deletions, 1);
  assert.deepEqual(await readdir(config.workRoot), []);
});
