// Requires an isolated local upload stack with the native image and jq's public macOS release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { UploadTicket, JobStatus } from '../src/contracts.js';
import type { StudioProject } from '@rea-studio/schema';

const JQ_SHA256 = 'e94b266e3c26690550006abe63152b782280f4e14374accdf04cbde844f00bc0';

test('HTTP macOS uploads: real Mach-O, private results, verified alias cache and format rejection',
  { timeout: 420_000 }, async (t) => {
    const configuredOrigin = process.env.PIPELINE_TEST_ORIGIN;
    const sample = process.env.PIPELINE_TEST_MACOS_FILE;
    if (!configuredOrigin || !sample)
      throw new Error('Set PIPELINE_TEST_ORIGIN and PIPELINE_TEST_MACOS_FILE to the isolated local stack and jq-1.8.2 jq-macos-amd64 file.');
    const url = new URL(configuredOrigin);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && !url.username && !url.password,
      'This check only sends the checksum-verified public sample to a loopback server.');
    const origin = url.origin;
    const signal = t.signal;
    const body = await readFile(sample);
    const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha256(body), JQ_SHA256, 'Use the published jq-1.8.2 jq-macos-amd64 bytes; never a private target.');
    const post = (path: string, value?: unknown, token?: string) => fetch(`${origin}${path}`, {
      method: 'POST', signal,
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const state = async (ticket: UploadTicket) => {
      const response = await fetch(`${origin}/api/jobs/${ticket.jobId}`, {
        headers: { Authorization: `Bearer ${ticket.jobToken}` }, signal,
      });
      assert.equal(response.status, 200);
      return await response.json() as JobStatus;
    };
    const project = (ticket: UploadTicket, token?: string) => fetch(`${origin}/api/jobs/${ticket.jobId}/project`, {
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}), signal,
    });
    const prepare = async (name: string, bytes = body) => {
      const response = await post('/api/uploads', { name, bytes: bytes.length, sha256: sha256(bytes) });
      assert.equal(response.status, 201);
      return await response.json() as UploadTicket;
    };
    const upload = (ticket: UploadTicket, bytes: Buffer) => fetch(ticket.uploadUrl, {
      method: 'PUT', headers: { ...ticket.headers, Origin: origin }, body: bytes, signal,
    });
    const observedPhases = new Set<string>();
    const finish = async (ticket: UploadTicket) => {
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        const status = await state(ticket);
        if (status.progress) observedPhases.add(status.progress.phase);
        if (status.status === 'succeeded' || status.status === 'failed') return status;
        await delay(250, undefined, { signal });
      }
      throw new Error('The local macOS upload did not finish within five minutes.');
    };
    const submit = async (name: string, bytes = body) => {
      const ticket = await prepare(name, bytes);
      assert.equal((await upload(ticket, bytes)).status, 204);
      assert.equal((await post(`/api/uploads/${ticket.jobId}/complete`, undefined, ticket.jobToken)).status, 202);
      return { ticket, status: await finish(ticket) };
    };

    for (const name of ['Notes.app', 'Notes.ipa', 'jq', 'libnotes.dylib.1'])
      assert.equal((await post('/api/uploads', { name, bytes: body.length, sha256: JQ_SHA256 })).status, 400);

    const fresh = await submit('jq.macho');
    assert.equal(fresh.status.status, 'succeeded', fresh.status.error);
    assert.equal(fresh.status.cacheHit, false, 'Use fresh isolated storage to verify analysis rather than a prior cache.');
    assert.equal(fresh.status.uploadName, 'jq.macho');
    assert.ok(observedPhases.size > 0, 'The real queued analysis must expose progress.');
    assert.equal((await project(fresh.ticket)).status, 404);
    assert.equal((await project(fresh.ticket, '0'.repeat(64))).status, 404);
    const response = await project(fresh.ticket, fresh.ticket.jobToken);
    assert.equal(response.status, 200);
    const normalized = await response.json() as StudioProject;
    assert.equal(normalized.id, fresh.status.projectId);
    assert.equal(normalized.target.format, 'macho');
    assert.equal(normalized.target.appKind, 'native');
    assert.equal(normalized.target.sha256, JQ_SHA256);
    assert.equal(normalized.analysis.coverage.status, 'complete');
    assert.equal(normalized.nodes.filter(n => n.kind === 'native-function').length, 1537);
    assert.equal(normalized.nodes.filter(n => n.kind === 'native-import').length, 130);
    const ids = new Set(normalized.nodes.map(n => n.id));
    assert.ok(normalized.edges.every(e => ids.has(e.source) && ids.has(e.target)));
    assert.equal((await post(`/api/uploads/${fresh.ticket.jobId}/complete`, undefined, fresh.ticket.jobToken)).status, 202);

    for (const name of ['another-jq.MACHO', 'libjq.DYLIB']) {
      const cached = await submit(name);
      assert.equal(cached.status.status, 'succeeded', cached.status.error);
      assert.equal(cached.status.cacheHit, true);
      assert.equal(cached.status.projectId, fresh.status.projectId);
      assert.equal(cached.status.uploadName, name);
      const saved = await (await project(cached.ticket, cached.ticket.jobToken)).json() as StudioProject;
      assert.equal(saved.target.name, normalized.target.name, 'Cached artifacts never inherit an uploader’s label.');
    }

    // Knowing a cached hash is insufficient: no completion/result before verified bytes arrive.
    const incomplete = await prepare('not-uploaded.dylib');
    assert.equal((await post(`/api/uploads/${incomplete.jobId}/complete`, undefined, incomplete.jobToken)).status, 409);
    assert.equal((await state(incomplete)).status, 'awaiting-upload');
    assert.equal((await project(incomplete, incomplete.jobToken)).status, 409);
    const wrongBytes = Buffer.from(body);
    const lastByte = wrongBytes.length - 1;
    wrongBytes.writeUInt8(wrongBytes.readUInt8(lastByte) ^ 1, lastByte);
    assert.equal((await upload(incomplete, wrongBytes)).status, 400);
    assert.equal((await post(`/api/uploads/${incomplete.jobId}/complete`, undefined, incomplete.jobToken)).status, 409);
    assert.equal((await project(incomplete, incomplete.jobToken)).status, 409);

    const root = resolve(import.meta.dirname, '../../../..');
    const pe = await readFile(join(root, 'fixtures/sample-apps/tiny-native/tiny-notes.exe'));
    const elf = await readFile(join(root, 'fixtures/sample-apps/tiny-linux/tiny-notes'));
    const universalHeader = Buffer.alloc(16);
    universalHeader.writeUInt32BE(0xcafebabe, 0);
    universalHeader.writeUInt32BE(2, 4);
    for (const [name, bytes] of [
      ['macos.exe', body], ['macos.elf', body], ['macos.asar', body],
      ['windows.macho', pe], ['linux.dylib', elf], ['universal.macho', universalHeader],
    ] as const) {
      const invalid = await submit(name, bytes);
      assert.equal(invalid.status.status, 'failed', `${name} must reach its own parser`);
      assert.equal(invalid.status.cacheHit, undefined);
      assert.equal((await project(invalid.ticket, invalid.ticket.jobToken)).status, 409);
    }
  });
