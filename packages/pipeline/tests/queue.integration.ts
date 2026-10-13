// Opt-in real Redis test. Uses a unique namespace; no target execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { UploadControl, type PipelineConfig } from '../src/server.js';
import { LocalStore, uploadKey } from '../src/storage.js';
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
    const worker = startAnalysisWorker(config, async ({ onProgress }) => {
      calls++;
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
  },
);
