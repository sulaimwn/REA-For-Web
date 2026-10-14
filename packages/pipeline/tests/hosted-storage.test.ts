import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { checkHostedDisk, HostedLocalStore, HOSTED_DISK_HEADROOM } from '../src/hosted-storage.js';
import { uploadKey } from '../src/storage.js';

const disk = { type: 0xef53n, bsize: 4096n, blocks: 16n * 1024n * 1024n, bavail: 16n * 1024n * 1024n };
test('hosted storage refuses unbounded root disks, RAM filesystems, invalid capacity and inadequate headroom', () => {
  checkHostedDisk(disk, HOSTED_DISK_HEADROOM);
  for (const bad of [{ ...disk, blocks: disk.blocks + 1n }, { ...disk, bsize: 0n },
    { ...disk, type: 0x01021994n }, { ...disk, bavail: -1n }]) assert.throws(() => checkHostedDisk(bad));
  assert.throws(() => checkHostedDisk({ ...disk, bavail: 1n }, HOSTED_DISK_HEADROOM));
});

test('hosted transfer checks bytes/hash, times out stalled streams, and removes partial data', async t => {
  const parent = resolve(import.meta.dirname, '../../../..');
  const root = await mkdtemp(join(parent, '.pipeline-test-'));
  const data = join(root, 'objects');
  await mkdir(data, { mode: 0o700 });
  t.after(async () => { assert.equal(dirname(root), parent); await rm(root, { recursive: true, force: true }); });
  const shortDeadline = new HostedLocalStore(data, 'a'.repeat(64), async () => disk, 30);
  const store = new HostedLocalStore(data, 'a'.repeat(64), async () => disk, 5000);
  const bytes = Buffer.from('inert hosted input');
  const request = { name: 'tiny.asar', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const id = randomUUID();
  const url = new URL((await store.signUpload(id, request, 'https://uploads.example')).url);
  const receive = (body: Readable) => store.receive(id, request, Number(url.searchParams.get('expires')), url.searchParams.get('signature')!, body);
  await assert.rejects(shortDeadline.receive(id, request, Number(url.searchParams.get('expires')), url.searchParams.get('signature')!, new Readable({ read() {} })), /too long/u);
  assert.deepEqual(await readdir(join(data, 'uploads')), []);
  await assert.rejects(receive(Readable.from(Buffer.alloc(bytes.length))), /SHA/u);
  assert.equal(await store.head(uploadKey(id)), null);
  await receive(Readable.from(bytes));
  assert.equal((await store.head(uploadKey(id)))?.bytes, bytes.length);
});
