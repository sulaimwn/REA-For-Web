// Uses the dedicated integration Redis: CLIENT PAUSE affects the entire instance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { UploadControl, type PipelineConfig } from '../src/server.js';
import { LocalStore, uploadKey } from '../src/storage.js';

test('upload API Redis stalls fail promptly and recover without losing upload ownership',
  { timeout: 60000 }, async (t) => {
    const redisUrl = process.env.PIPELINE_TEST_REDIS_URL;
    if (!redisUrl) throw new Error('Set PIPELINE_TEST_REDIS_URL to a dedicated test instance.');
    const testRoot = resolve(import.meta.dirname, '../../../..');
    const root = await mkdtemp(join(testRoot, '.pipeline-test-'));
    const config: PipelineConfig = {
      redisUrl, prefix: `test-api-${randomUUID()}`, origin: 'http://localhost:3104',
      store: new LocalStore(join(root, 'objects'), 'a'.repeat(64)), workRoot: join(root, 'work'),
    };
    const c = new UploadControl(config);
    const admin = new Redis(redisUrl, { maxRetriesPerRequest: 1, commandTimeout: 15000 });
    admin.on('error', () => {});
    t.after(async () => {
      await admin.call('CLIENT', 'UNPAUSE');
      await c.queue.obliterate({ force: true });
      for (const key of await admin.keys(`${config.prefix}:*`)) await admin.del(key);
      await c.close();
      admin.disconnect();
      assert.equal(dirname(root), testRoot);
      await rm(root, { recursive: true, force: true });
    });
    await c.ready();
    await c.queue.waitUntilReady();

    async function stalled(action: () => Promise<unknown>, mode: 'ALL' | 'WRITE') {
      await admin.call('CLIENT', 'PAUSE', '12000', mode);
      assert.equal(c.redis.status, 'ready');
      const started = Date.now();
      const operation = action().then(
        () => ({ state: 'fulfilled' as const, error: '' }),
        (error: unknown) => ({ state: 'rejected' as const, error: String(error) }),
      );
      try {
        const result = await Promise.race([
          operation, delay(6500).then(() => ({ state: 'pending' as const, error: '' })),
        ]);
        assert.equal(result.state, 'rejected', `request still ${result.state} after ${Date.now() - started} ms`);
        assert.match(result.error, /timed out/u);
        assert.ok(Date.now() - started < 6500);
        assert.equal(c.redis.status, 'ready', 'the deadline also works while TCP stays connected');
        t.diagnostic(`${mode} request rejected after ${Date.now() - started} ms`);
      } finally {
        // ALL mode can also delay UNPAUSE. Wait for the bounded server pause,
        // then check protocol use after replies to timed-out commands arrive.
        await admin.call('CLIENT', 'UNPAUSE');
        await operation;
      }
      assert.equal(await c.redis.ping(), 'PONG');
      assert.equal(await c.queue.getJobCountByTypes('wait'), 0);
    }

    await t.test('connected but stalled reads are bounded', async () => {
      await stalled(() => c.ready(), 'ALL');
    });
    const bytes = Buffer.from('inert upload API recovery fixture');
    const request = { name: 'tiny.asar', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
    await t.test('timed-out admission never returns a ticket and its quota still expires', async () => {
      await stalled(() => c.create(request), 'WRITE');
      assert.deepEqual(await admin.keys(`${config.prefix}:upload:*`), []);
      const quotaKeys = await admin.keys(`${config.prefix}:admission:*`);
      assert.equal(quotaKeys.length, 1);
      assert.ok(await admin.ttl(quotaKeys[0]!) > 0, 'an ambiguous admission write must not leave an immortal quota key');
    });
    const ticket = await c.create(request);
    const record = await c.authorize(ticket.jobId, ticket.jobToken);
    const signed = new URL(ticket.uploadUrl);
    await (config.store as LocalStore).receive(record.id, record,
      Number(signed.searchParams.get('expires')), signed.searchParams.get('signature')!, Readable.from(bytes));
    await t.test('queue writes are bounded and the same upload can be retried safely', async () => {
      await stalled(() => c.complete(record.id, ticket.jobToken), 'WRITE');
      assert.equal((await config.store.head(uploadKey(record.id)))?.bytes, bytes.length);
      assert.equal((await c.status(record.id, ticket.jobToken)).status, 'awaiting-upload');
      await assert.rejects(c.status(record.id, '0'.repeat(64)), /not found/u);
      await Promise.all([c.complete(record.id, ticket.jobToken), c.complete(record.id, ticket.jobToken)]);
      assert.equal((await c.status(record.id, ticket.jobToken)).status, 'queued');
      assert.equal(await c.queue.getJobCountByTypes('wait'), 1);
      assert.equal(await c.queue.getGlobalConcurrency(), 1);
      await assert.rejects(c.project(record.id, ticket.jobToken), /not ready/u);
    });
  });
