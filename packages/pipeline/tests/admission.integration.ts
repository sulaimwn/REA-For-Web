// Dedicated Redis only. Real concurrent admission/queue/storage, inert bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { UploadControl } from '../src/server.js';
import { networkIdentity, MAX_PENDING_UPLOADS, UPLOAD_BUSY_MESSAGE } from '../src/admission.js';
import { LocalStore } from '../src/storage.js';
import { PipelineError } from '../src/contracts.js';

const body = Buffer.from('inert admission fixture');
const request = { name: 'tiny.asar', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
const secret = 'admission-test-private-network-secret';
const rootParent = resolve(import.meta.dirname, '../../../..');

async function setup(t: import('node:test').TestContext) {
  const redisUrl = process.env.PIPELINE_TEST_REDIS_URL;
  if (!redisUrl) throw new Error('Set PIPELINE_TEST_REDIS_URL to a dedicated test Redis instance.');
  const root = await mkdtemp(join(rootParent, '.pipeline-test-'));
  const store = new LocalStore(join(root, 'objects'), 'a'.repeat(64));
  const control = new UploadControl({ redisUrl, prefix: `test-admission-${randomUUID()}`,
    origin: 'http://localhost:3104', store, workRoot: join(root, 'work') });
  t.after(async () => {
    await control.queue.obliterate({ force: true });
    for (const key of await control.redis.keys(`${control.config.prefix}:*`)) await control.redis.del(key);
    await control.close();
    assert.equal(dirname(root), rootParent);
    await rm(root, { recursive: true, force: true });
  });
  await control.ready();
  await control.queue.waitUntilReady();
  return { control, store, pending: `${control.config.prefix}:admission-pending` };
}

function busy(error: unknown) {
  return error instanceof PipelineError && error.status === 503 && error.message === UPLOAD_BUSY_MESSAGE;
}
async function receive(control: UploadControl, store: LocalStore, ticket: Awaited<ReturnType<UploadControl['create']>>) {
  const url = new URL(ticket.uploadUrl);
  const record = await control.authorize(ticket.jobId, ticket.jobToken);
  await store.receive(ticket.jobId, record, Number(url.searchParams.get('expires')),
    url.searchParams.get('signature')!, Readable.from(body));
}

test('concurrent tickets across web instances cannot overfill the pending capacity', async t => {
  const { control, pending } = await setup(t);
  const second = new UploadControl(control.config);
  t.after(() => second.close());
  await second.ready();
  const attempts = await Promise.allSettled(Array.from({ length: 30 }, (_, i) =>
    (i % 2 ? control : second).create(request)));
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, MAX_PENDING_UPLOADS);
  for (const value of attempts.filter(value => value.status === 'rejected')) assert.ok(busy(value.reason));
  assert.equal(await control.redis.zcard(pending), MAX_PENDING_UPLOADS);
  const budget = `${control.config.prefix}:admission:${Math.floor(Date.now() / 86400000)}`;
  assert.equal(await control.redis.get(budget), String(MAX_PENDING_UPLOADS));
  assert.ok(await control.redis.ttl(budget) > 0);
  // Body-less tickets expire without consuming slots forever.
  await control.redis.zadd(pending, 0, (attempts.find(value => value.status === 'fulfilled')! as PromiseFulfilledResult<Awaited<ReturnType<UploadControl['create']>>>).value.jobId);
  await control.create(request);
  assert.equal(await control.redis.zcard(pending), MAX_PENDING_UPLOADS);
});

test('atomic visitor quotas cannot be raced and do not store raw network addresses', async t => {
  const { control } = await setup(t);
  const identity = networkIdentity('2001:db8:abcd:1234::1', secret);
  const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => control.create(request, identity)));
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 5);
  for (const value of outcomes.filter(value => value.status === 'rejected'))
    assert.ok(value.reason instanceof PipelineError && value.reason.status === 429 && /hourly/u.test(value.reason.message));
  const keys = await control.redis.keys(`${control.config.prefix}:visitor:*`);
  assert.equal(keys.length, 2);
  assert.ok(keys.every(key => key.includes(identity) && !key.includes('2001:')));
  for (const key of keys) assert.ok(await control.redis.ttl(key) > 0);
  const daily = keys.find(key => key.includes(':day:'))!;
  const hourly = keys.find(key => key.includes(':hour:'))!;
  await control.redis.set(hourly, 0, 'EX', 7200);
  await control.redis.set(daily, 15, 'EX', 172800);
  await assert.rejects(control.create(request, identity), error =>
    error instanceof PipelineError && error.status === 429 && /daily/u.test(error.message));
  await control.create(request, networkIdentity('192.0.2.1', secret));
  control.config.visitorSecret = secret;
  await assert.rejects(control.create(request), /identity/u);
});

test('queue admission counts waiting jobs, rejects expired-lease bypass and keeps completion idempotent', async t => {
  const { control, store, pending } = await setup(t);
  const ticket = await control.create(request);
  await receive(control, store, ticket);
  await Promise.all([control.complete(ticket.jobId, ticket.jobToken), control.complete(ticket.jobId, ticket.jobToken)]);
  assert.equal(await control.queue.getJobCountByTypes('wait'), 1);
  assert.equal(await control.redis.zscore(pending, ticket.jobId), null);
  const late = await control.create(request);
  await receive(control, store, late);
  await control.redis.zadd(pending, 0, late.jobId);
  const reservations = await Promise.all(Array.from({ length: MAX_PENDING_UPLOADS - 1 }, () => control.create(request)));
  await assert.rejects(control.create(request), busy);
  await assert.rejects(control.complete(late.jobId, late.jobToken), busy);
  // Finishing/removing one job frees space; an expired ticket may then complete.
  const queued = await control.queue.getJob(ticket.jobId);
  await queued!.remove();
  await control.complete(late.jobId, late.jobToken);
  assert.equal(await control.queue.getJobCountByTypes('wait'), 1);
  assert.equal(await control.redis.zcard(pending), reservations.length);
  await control.complete(late.jobId, late.jobToken);
  assert.equal(await control.queue.getJobCountByTypes('wait'), 1);
});

test('ambiguous queue failure retains capacity until the same job is confirmed queued', async t => {
  const { control, store, pending } = await setup(t);
  const ticket = await control.create(request);
  await receive(control, store, ticket);
  const add = control.queue.add.bind(control.queue);
  control.queue.add = async () => { throw new Error('simulated ambiguous queue timeout'); };
  await assert.rejects(control.complete(ticket.jobId, ticket.jobToken), /ambiguous/u);
  assert.equal(await control.redis.zscore(pending, ticket.jobId), 'inf');
  control.queue.add = add;
  await control.complete(ticket.jobId, ticket.jobToken);
  assert.equal(await control.redis.zscore(pending, ticket.jobId), null);
  assert.equal(await control.queue.getJobCountByTypes('wait'), 1);
});

test('capacity includes paused, prioritized, delayed and active jobs, plus the global daily ceiling', async t => {
  const { control } = await setup(t);
  const record = { ...request, id: randomUUID(), tokenHash: 'a'.repeat(64), createdAt: Date.now() };
  await control.queue.pause();
  await control.queue.add('inert', record, { jobId: randomUUID() });
  await control.queue.add('inert', record, { jobId: randomUUID(), priority: 2 });
  await control.queue.add('inert', record, { jobId: randomUUID(), delay: 60000 });
  // No target/worker runs; one inert active list entry tests the same collection.
  await control.redis.lpush(control.queue.toKey('active'), 'inert-active-entry');
  const results = await Promise.allSettled(Array.from({ length: 25 }, () => control.create(request)));
  assert.equal(results.filter(value => value.status === 'fulfilled').length, MAX_PENDING_UPLOADS - 4);
  await control.redis.del(`${control.config.prefix}:admission-pending`);
  await control.redis.set(`${control.config.prefix}:admission:${Math.floor(Date.now() / 86400000)}`, 100);
  await assert.rejects(control.create(request), error => error instanceof PipelineError && error.status === 429);
});

test('hosted public ceilings cover visitor, owner, daily and monthly admissions', async t => {
  const { control, pending } = await setup(t);
  control.config.hostedLocal = true;
  control.config.visitorSecret = secret;
  const identity = networkIdentity('192.0.2.1', secret);
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => control.create(request, identity)));
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 3);
  for (const value of attempts.filter(value => value.status === 'rejected'))
    assert.ok(value.reason instanceof PipelineError && value.reason.status === 429 && /daily/u.test(value.reason.message));
  await control.create(request, undefined, true);
  await control.redis.del(pending);
  const day = `${control.config.prefix}:admission:${Math.floor(Date.now() / 86400000)}`;
  const month = `${control.config.prefix}:admission-month:${new Date().toISOString().slice(0, 7)}`;
  await control.redis.set(day, 25);
  await assert.rejects(control.create(request, undefined, true), /daily upload/u);
  await control.redis.set(day, 0);
  await control.redis.set(month, 500);
  await assert.rejects(control.create(request, undefined, true), /monthly upload/u);
  assert.equal(await control.redis.get(day), '0', 'denied monthly admission must not burn daily capacity');
});

test('hosted transfer claims cannot be replayed or exceed two simultaneous body slots', async t => {
  const { control } = await setup(t);
  const ticket = await control.create(request);
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => control.claimTransfer(ticket.jobId)));
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
  for (const value of attempts.filter(value => value.status === 'rejected'))
    assert.ok(value.reason instanceof PipelineError && value.reason.status === 409);
  const second = await control.create(request);
  const third = await control.create(request);
  await control.claimTransfer(second.jobId);
  await assert.rejects(control.claimTransfer(third.jobId), error => error instanceof PipelineError && error.status === 503);
  assert.equal(await control.redis.exists(`${control.config.prefix}:transfer-used:${third.jobId}`), 0,
    'a busy slot must not consume the third ticket');
  await control.finishTransfer(ticket.jobId, true);
  await assert.rejects(control.claimTransfer(ticket.jobId), /already been used/u);
  await control.claimTransfer(third.jobId);
  const active = `${control.config.prefix}:transfer-active`;
  assert.equal(await control.redis.zcard(active), 2);
  assert.ok(await control.redis.ttl(`${control.config.prefix}:transfer-used:${ticket.jobId}`) > 0);
  await control.finishTransfer(second.jobId, false);
  await control.finishTransfer(third.jobId, false);
  assert.equal(await control.redis.zcard(active), 0);
});
