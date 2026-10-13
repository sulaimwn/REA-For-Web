// Dedicated local Redis; real admission/queue/storage, inert analysis runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalStore, uploadKey } from '../src/storage.js';
import { UploadControl, type PipelineConfig } from '../src/server.js';
import { startAnalysisWorker } from '../src/processor.js';
import { preanalyzeFile, PreanalysisError } from '../src/preanalyze.js';

test('operator seeds through real admission/global queue, later verified uploads reuse it, and quota still applies', { timeout: 30000 }, async t => {
  const redisUrl = process.env.PIPELINE_TEST_REDIS_URL;
  if (!redisUrl || !['localhost', '127.0.0.1'].includes(new URL(redisUrl).hostname))
    throw new Error('Set PIPELINE_TEST_REDIS_URL to a dedicated loopback Redis.');
  const parent = resolve(import.meta.dirname, '../../../..');
  const root = await mkdtemp(join(parent, '.pipeline-test-'));
  const store = new LocalStore(join(root, 'objects'), 'a'.repeat(64));
  const config: PipelineConfig = { store, redisUrl, origin: 'http://localhost:3184', prefix: `seed-${randomUUID()}`, workRoot: join(root, 'work') };
  const control = new UploadControl(config);
  const body = Buffer.from('public inert ELF-labeled fixture for queue checks');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const sourcePath = join(root, 'notes.elf');
  await writeFile(sourcePath, body);
  let active = 0, peak = 0, calls = 0;
  const worker = startAnalysisWorker(config, async ({ targetPath, targetName, outputRoot }) => {
    active++; peak = Math.max(peak, active); calls++;
    try {
      assert.equal(targetName, 'target.elf');
      assert.deepEqual(await readFile(targetPath), body);
      await delay(150);
      await mkdir(outputRoot, { recursive: true });
      const projectPath = join(outputRoot, 'project.json');
      await writeFile(projectPath, JSON.stringify({ id: 'b'.repeat(64) }));
      return { projectPath, projectId: 'b'.repeat(64) };
    } finally { active--; }
  });
  t.after(async () => {
    await worker.close();
    await control.queue.obliterate({ force: true });
    for (const key of await control.redis.keys(`${config.prefix}:*`)) await control.redis.del(key);
    await control.close();
    assert.equal(dirname(root), parent);
    await rm(root, { recursive: true, force: true });
  });
  await worker.waitUntilReady();
  const seeded = await Promise.all([
    preanalyzeFile(control, { sourcePath, expectedSha256: sha256 }),
    preanalyzeFile(control, { sourcePath, expectedSha256: sha256 }),
  ]);
  assert.deepEqual(seeded.map(result => result.cacheHit).sort(), [false, true]);
  assert.equal(calls, 1);
  assert.equal(peak, 1);
  assert.equal(await control.queue.getGlobalConcurrency(), 1);
  // Normal visitor-style signed upload of the .so alias still proves possession.
  const request = { name: 'visitor.so', bytes: body.length, sha256 };
  const ticket = await control.create(request);
  const signed = new URL(ticket.uploadUrl);
  await store.receive(ticket.jobId, request, Number(signed.searchParams.get('expires')), signed.searchParams.get('signature')!, Readable.from(body));
  await control.complete(ticket.jobId, ticket.jobToken);
  let status = await control.status(ticket.jobId, ticket.jobToken);
  for (let n = 0; n < 50 && status.status !== 'succeeded'; n++) { await delay(50); status = await control.status(ticket.jobId, ticket.jobToken); }
  assert.equal(status.status, 'succeeded');
  assert.equal(status.cacheHit, true);
  assert.equal(status.uploadName, 'visitor.so');
  await assert.rejects(control.project(ticket.jobId, '0'.repeat(64)));
  assert.equal(await store.head(uploadKey(ticket.jobId, 'elf')), null);
  assert.deepEqual(await readdir(config.workRoot), []);
  assert.deepEqual(await readdir(join(root, 'objects', 'uploads')), []);
  // Operators use the same admission budget; pre-analysis cannot bypass it.
  await control.redis.set(`${config.prefix}:admission:${Math.floor(Date.now() / 86400000)}`, '100');
  await assert.rejects(preanalyzeFile(control, { sourcePath }), error => error instanceof PreanalysisError && error.stage === 'upload admission');
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(join(root, 'objects', 'uploads')), []);
  // Pause this dedicated Redis to exercise actual CLI interruption/connection
  // shutdown, not just cancellation of an injected status promise.
  const preload = join(root, 'interrupt.mjs');
  await writeFile(preload, 'setTimeout(() => process.emit("SIGINT"), 1200).unref();');
  await control.redis.call('CLIENT', 'PAUSE', '10000', 'WRITE');
  const started = Date.now();
  const interrupted = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath,
      ['--import', pathToFileURL(preload).href, join(parent, 'scripts/preanalyze-cache.mjs'), sourcePath], {
        cwd: parent, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PIPELINE_STORAGE: 'local', PIPELINE_PUBLIC_ORIGIN: config.origin,
          REDIS_URL: redisUrl, PIPELINE_QUEUE_PREFIX: config.prefix, PIPELINE_DATA_ROOT: store.root,
          PIPELINE_WORK_ROOT: config.workRoot, PIPELINE_UPLOAD_SECRET: 'a'.repeat(64) },
      });
    let output = '';
    const deadline = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(deadline); resolve({ code, output }); });
  });
  assert.equal(interrupted.code, 1);
  assert.match(interrupted.output, /Stopped waiting/u);
  assert.ok(Date.now() - started < 6000, 'CLI must disconnect its own clients before Redis resumes');
});
