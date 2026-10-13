// Opt-in real Redis test. Uses a unique namespace; no target execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { UploadControl, type PipelineConfig } from '../src/server.js';
import { LocalStore, resultKey, uploadKey } from '../src/storage.js';
import { startAnalysisWorker } from '../src/processor.js';

test(
  'Redis queue completion is idempotent, token-protected, and persists progress and result',
  { timeout: 30000 },
  async (t) => {
    const redisUrl = process.env.PIPELINE_TEST_REDIS_URL;
    if (!redisUrl)
      throw new Error(
        'Set PIPELINE_TEST_REDIS_URL for the dedicated integration Redis instance.',
      );
    const testRoot = resolve(import.meta.dirname, '../../../..');
    const root = await mkdtemp(join(testRoot, '.pipeline-test-'));
    const store = new LocalStore(join(root, 'objects'), 'a'.repeat(64));
    const config: PipelineConfig = {
      store,
      redisUrl,
      origin: 'http://localhost:3104',
      prefix: `test-${randomUUID()}`,
      workRoot: join(root, 'work'),
    };
    const c = new UploadControl(config);
    let calls = 0;
    let simulateTimeout = false;
    let stallProgress = false;
    let notifyProgressStall: ((time: number) => void) | undefined;
    const worker = startAnalysisWorker(config, async ({ onProgress, targetName }) => {
      calls++;
      assert.equal(targetName, 'target.asar');
      if (stallProgress) {
        // This suite requires a dedicated Redis instance. Pause actual writes,
        // including BullMQ progress persistence, without touching other stacks.
        await c.redis.call('CLIENT', 'PAUSE', '12000', 'WRITE');
        notifyProgressStall?.(Date.now());
      }
      onProgress({ phase: 'test', message: 'Fixture normalization' });
      await delay(150);
      if (simulateTimeout)
        throw Object.assign(new Error('/private/path?secret=token'), {
          code: 'timeout',
        });
      const path = join(root, 'project.json');
      await writeFile(path, JSON.stringify({ id: 'b'.repeat(64) }));
      return { projectPath: path, projectId: 'b'.repeat(64) };
    });
    t.after(async () => {
      await worker.close();
      await c.queue.obliterate({ force: true });
      for (const key of await c.redis.keys(`${config.prefix}:*`))
        await c.redis.del(key);
      await c.close();
      assert.equal(dirname(root), testRoot);
      await rm(root, { recursive: true, force: true });
    });
    await worker.waitUntilReady();
    const bytes = Buffer.from('inert test archive');
    const ticket = await c.create({
      name: 'tiny.asar',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    await assert.rejects(c.status(ticket.jobId, '0'.repeat(64)));
    await assert.rejects(
      c.complete(ticket.jobId, ticket.jobToken),
      /not finished/u,
    );
    const url = new URL(ticket.uploadUrl),
      r = await c.authorize(ticket.jobId, ticket.jobToken);
    await store.receive(
      r.id,
      r,
      Number(url.searchParams.get('expires')),
      url.searchParams.get('signature')!,
      Readable.from(bytes),
    );
    await Promise.all([
      c.complete(r.id, ticket.jobToken),
      c.complete(r.id, ticket.jobToken),
    ]);
    let state = await c.status(r.id, ticket.jobToken);
    for (
      let attempt = 0;
      attempt < 100 &&
      state.status !== 'succeeded' &&
      state.status !== 'failed';
      attempt++
    ) {
      await delay(100);
      state = await c.status(r.id, ticket.jobToken);
    }
    assert.equal(state.status, 'succeeded');
    assert.equal(state.uploadName, 'tiny.asar');
    assert.equal(calls, 1);
    assert.equal(state.projectId, 'b'.repeat(64));
    assert.equal(await store.head(uploadKey(r.id)), null);
    const reconnect = new UploadControl(config);
    await t.test('status survives API connection recreation', async () => {
      assert.equal(
        (await reconnect.status(r.id, ticket.jobToken)).status,
        'succeeded',
      );
      await reconnect.close();
    });
    await assert.rejects(c.project(r.id, '0'.repeat(64)));
    await t.test('timeout keeps the last progress, offers a fresh upload, and removes raw data', async () => {
      simulateTimeout = true;
      const otherBytes = Buffer.from('different inert archive for timeout');
      const timeoutTicket = await c.create({
        name: 'slow.asar',
        bytes: otherBytes.length,
        sha256: createHash('sha256').update(otherBytes).digest('hex'),
      });
      const slow = await c.authorize(timeoutTicket.jobId, timeoutTicket.jobToken);
      const signed = new URL(timeoutTicket.uploadUrl);
      await store.receive(
        slow.id, slow, Number(signed.searchParams.get('expires')),
        signed.searchParams.get('signature')!, Readable.from(otherBytes),
      );
      await c.complete(slow.id, timeoutTicket.jobToken);
      let failed = await c.status(slow.id, timeoutTicket.jobToken);
      for (let attempt = 0; attempt < 100 && failed.status !== 'failed'; attempt++) {
        await delay(100);
        failed = await c.status(slow.id, timeoutTicket.jobToken);
      }
      assert.equal(failed.status, 'failed');
      assert.equal(failed.errorCode, 'timeout');
      assert.match(failed.error!, /upload it again/u);
      assert.doesNotMatch(failed.error!, /private|secret/u);
      assert.equal(failed.progress?.message, 'Fixture normalization');
      assert.equal(await store.head(uploadKey(slow.id)), null);
      await assert.rejects(c.project(slow.id, timeoutTicket.jobToken), /not ready/u);
    });
    await t.test('a Redis write stall cleans raw/staging before reconnecting and the queue recovers', async () => {
      simulateTimeout = false;
      stallProgress = true;
      const stalledBytes = Buffer.from('unique inert archive for a progress write stall');
      const stalledTicket = await c.create({
        name: 'stalled.asar', bytes: stalledBytes.length,
        sha256: createHash('sha256').update(stalledBytes).digest('hex'),
      });
      const stalled = await c.authorize(stalledTicket.jobId, stalledTicket.jobToken);
      const signed = new URL(stalledTicket.uploadUrl);
      await store.receive(stalled.id, stalled, Number(signed.searchParams.get('expires')),
        signed.searchParams.get('signature')!, Readable.from(stalledBytes));
      const paused = new Promise<number>((resolvePause) => { notifyProgressStall = resolvePause; });
      const completing = c.complete(stalled.id, stalledTicket.jobToken);
      void completing.catch(() => {});
      const pausedAt = await paused;
      while (await store.head(uploadKey(stalled.id))) {
        if (Date.now() - pausedAt > 8000) break;
        await delay(50);
      }
      assert.equal(await store.head(uploadKey(stalled.id)), null, 'raw data is removed while Redis writes are still stalled');
      assert.deepEqual(await readdir(config.workRoot), []);
      assert.equal(await store.head(resultKey(stalled.sha256)), null);
      assert.ok(Date.now() - pausedAt < 12000, 'cleanup does not wait for Redis writes to resume');
      await completing;
      let failed = await c.status(stalled.id, stalledTicket.jobToken);
      for (let attempt = 0; attempt < 100 && failed.status !== 'failed'; attempt++) {
        await delay(100);
        failed = await c.status(stalled.id, stalledTicket.jobToken);
      }
      assert.equal(failed.status, 'failed');
      assert.match(failed.error!, /queue connection/u);
      assert.match(failed.error!, /upload it again/u);
      await assert.rejects(c.project(stalled.id, stalledTicket.jobToken), /not ready/u);
      stallProgress = false;

      const nextBytes = Buffer.from('unique inert archive after Redis recovery');
      const nextTicket = await c.create({ name: 'next.asar', bytes: nextBytes.length,
        sha256: createHash('sha256').update(nextBytes).digest('hex') });
      const next = await c.authorize(nextTicket.jobId, nextTicket.jobToken);
      const nextSigned = new URL(nextTicket.uploadUrl);
      await store.receive(next.id, next, Number(nextSigned.searchParams.get('expires')),
        nextSigned.searchParams.get('signature')!, Readable.from(nextBytes));
      await c.complete(next.id, nextTicket.jobToken);
      let recovered = await c.status(next.id, nextTicket.jobToken);
      for (let attempt = 0; attempt < 100 && recovered.status !== 'succeeded'; attempt++) {
        await delay(100);
        recovered = await c.status(next.id, nextTicket.jobToken);
      }
      assert.equal(recovered.status, 'succeeded');
      assert.equal(await store.head(uploadKey(next.id)), null);
    });
  },
);
