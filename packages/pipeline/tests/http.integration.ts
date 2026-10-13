// Requires a running local upload app, Redis and the real Docker worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, cp, rm, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPackage } from '@electron/asar';
import type { UploadTicket, JobStatus } from '../src/contracts.js';
import type { StudioProject } from '@rea-studio/schema';

test(
  'HTTP upload, real sandbox analysis, authenticated results, dedupe, and rejection paths',
  { timeout: 120000 },
  async (t) => {
    const origin = process.env.PIPELINE_TEST_ORIGIN;
    if (!origin)
      throw new Error(
        'Set PIPELINE_TEST_ORIGIN to the running local upload app.',
      );
    if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
      throw new Error(
        'This test only uploads public fixtures to a loopback server.',
      );
    const root = resolve(import.meta.dirname, '../../../..'),
      temp = await mkdtemp(join(root, '.pipeline-test-'));
    t.after(async () => {
      assert.equal(dirname(temp), root);
      await rm(temp, { recursive: true, force: true });
    });
    const source = join(temp, 'app');
    await cp(join(root, 'fixtures/sample-apps/tiny-electron'), source, {
      recursive: true,
    });
    await writeFile(join(source, 'test-marker.txt'), randomUUID());
    const archive = join(temp, 'tiny.asar');
    await createPackage(source, archive);
    const bytes = await readFile(archive);
    const request = {
      name: 'tiny.asar',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const post = (path: string, body: unknown, token?: string) =>
      fetch(`${origin}${path}`, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const state = async (ticket: UploadTicket) => {
      const response = await fetch(`${origin}/api/jobs/${ticket.jobId}`, {
        headers: { Authorization: `Bearer ${ticket.jobToken}` },
      });
      assert.equal(response.status, 200);
      return (await response.json()) as JobStatus;
    };
    const finish = async (ticket: UploadTicket) => {
      let result = await state(ticket);
      for (
        let i = 0;
        i < 300 && result.status !== 'succeeded' && result.status !== 'failed';
        i++
      ) {
        await delay(200);
        result = await state(ticket);
      }
      return result;
    };
    assert.equal(
      (await post('/api/uploads', { ...request, name: '../tiny.asar' })).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/uploads`, {
          method: 'POST',
          headers: {
            Origin: 'https://untrusted.example',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        })
      ).status,
      403,
    );
    const ticketResponse = await post('/api/uploads', request);
    assert.equal(ticketResponse.status, 201);
    const ticket = (await ticketResponse.json()) as UploadTicket;
    assert.equal(
      (await fetch(`${origin}/api/jobs/${ticket.jobId}`)).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/jobs/${ticket.jobId}/project`, {
          headers: { Authorization: `Bearer ${ticket.jobToken}` },
        })
      ).status,
      409,
    );
    assert.equal(
      (await post(`/api/uploads/${ticket.jobId}/complete`, {}, ticket.jobToken))
        .status,
      409,
    );
    const wrong = await fetch(ticket.uploadUrl, {
      method: 'PUT',
      headers: { ...ticket.headers, Origin: origin },
      body: Buffer.alloc(bytes.length),
    });
    assert.equal(wrong.status, 400);
    assert.equal(
      (
        await fetch(ticket.uploadUrl, {
          method: 'PUT',
          headers: { ...ticket.headers, Origin: origin },
          body: bytes,
        })
      ).status,
      204,
    );
    await Promise.all([
      post(`/api/uploads/${ticket.jobId}/complete`, {}, ticket.jobToken),
      post(`/api/uploads/${ticket.jobId}/complete`, {}, ticket.jobToken),
    ]).then((results) => results.forEach((r) => assert.equal(r.status, 202)));
    const first = await finish(ticket);
    assert.equal(first.status, 'succeeded');
    assert.equal(first.cacheHit, false);
    const resultResponse = await fetch(
      `${origin}/api/jobs/${ticket.jobId}/project`,
      { headers: { Authorization: `Bearer ${ticket.jobToken}` } },
    );
    assert.equal(resultResponse.status, 200);
    const project = (await resultResponse.json()) as StudioProject;
    assert.equal(project.schemaVersion, '0.1.0');
    assert.equal(project.id, first.projectId);
    assert.equal(project.target.name, 'tiny-electron');
    assert.equal(
      project.nodes.filter((n: { kind: string }) => n.kind === 'process')
        .length,
      3,
    );
    const next = (await (
      await post('/api/uploads', request)
    ).json()) as UploadTicket;
    assert.equal(
      (
        await fetch(next.uploadUrl, {
          method: 'PUT',
          headers: { ...next.headers, Origin: origin },
          body: bytes,
        })
      ).status,
      204,
    );
    assert.equal(
      (await post(`/api/uploads/${next.jobId}/complete`, {}, next.jobToken))
        .status,
      202,
    );
    const second = await finish(next);
    assert.equal(second.status, 'succeeded');
    assert.equal(second.cacheHit, true);
    assert.equal(second.projectId, first.projectId);
    const malformed = Buffer.from('invalid ASAR header');
    const invalid = (await (
      await post('/api/uploads', {
        name: 'invalid.asar',
        bytes: malformed.length,
        sha256: createHash('sha256').update(malformed).digest('hex'),
      })
    ).json()) as UploadTicket;
    assert.equal(
      (
        await fetch(invalid.uploadUrl, {
          method: 'PUT',
          headers: { ...invalid.headers, Origin: origin },
          body: malformed,
        })
      ).status,
      204,
    );
    await post(`/api/uploads/${invalid.jobId}/complete`, {}, invalid.jobToken);
    assert.equal((await finish(invalid)).status, 'failed');
    assert.equal(
      (
        await fetch(`${origin}/api/jobs/${invalid.jobId}/project`, {
          headers: { Authorization: `Bearer ${invalid.jobToken}` },
        })
      ).status,
      409,
    );
  },
);

test('HTTP program uploads: .NET EXE/DLL, native EXE, APK, dedupe and renamed-format rejection', { timeout: 300_000 }, async () => {
  const configuredOrigin = process.env.PIPELINE_TEST_ORIGIN;
  if (!configuredOrigin || !['localhost', '127.0.0.1'].includes(new URL(configuredOrigin).hostname)) {
    throw new Error('Set PIPELINE_TEST_ORIGIN to the local upload app with REA_NATIVE_WORKER=1.');
  }
  const origin = configuredOrigin;
  const root = resolve(import.meta.dirname, '../../../..');
  async function submit(name: string, body: Buffer) {
    const prepared = await fetch(`${origin}/api/uploads`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }),
    });
    assert.equal(prepared.status, 201);
    const ticket = await prepared.json() as UploadTicket;
    const uploaded = await fetch(ticket.uploadUrl, { method: 'PUT', headers: { ...ticket.headers, Origin: origin }, body });
    assert.equal(uploaded.status, 204);
    const queued = await fetch(`${origin}/api/uploads/${ticket.jobId}/complete`, {
      method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${ticket.jobToken}` },
    });
    assert.equal(queued.status, 202);
    let status: JobStatus | undefined;
    for (let attempt = 0; attempt < 600; attempt++) {
      const response = await fetch(`${origin}/api/jobs/${ticket.jobId}`, { headers: { Authorization: `Bearer ${ticket.jobToken}` } });
      assert.equal(response.status, 200);
      status = await response.json() as JobStatus;
      if (status.status === 'succeeded' || status.status === 'failed') break;
      await delay(200);
    }
    assert.ok(status);
    return { ticket, status };
  }
  const managed = await readFile(join(root, 'fixtures/sample-apps/tiny-dotnet/TinyNotes.exe'));
  const native = await readFile(join(root, 'fixtures/sample-apps/tiny-native/tiny-notes.exe'));
  const android = await readFile(join(root, 'fixtures/sample-apps/tiny-android/tiny-notes.apk'));
  for (const [name, body, appKind] of [
    ['notes.exe', managed, 'dotnet'], ['notes.dll', managed, 'dotnet'],
    ['native.exe', native, 'native'], ['notes.apk', android, 'android'],
  ] as const) {
    const { ticket, status } = await submit(name, body);
    assert.equal(status.status, 'succeeded', `${name}: ${status.error}`);
    assert.equal(status.uploadName, name);
    assert.equal((await fetch(`${origin}/api/jobs/${ticket.jobId}/project`)).status, 404);
    const response = await fetch(`${origin}/api/jobs/${ticket.jobId}/project`, { headers: { Authorization: `Bearer ${ticket.jobToken}` } });
    assert.equal(response.status, 200);
    const project = await response.json() as StudioProject;
    assert.equal(project.target.appKind, appKind);
    assert.equal(project.id, status.projectId);
    if (appKind === 'dotnet') assert.equal(project.nodes.filter((n) => n.kind === 'native-import').length, 3);
    if (appKind === 'native') assert.equal(project.nodes.filter((n) => n.kind === 'native-function').length, 49);
    if (appKind === 'android') {
      assert.equal(project.nodes.filter((n) => n.kind === 'android-component').length, 4);
      assert.equal(project.analysis.coverage.status, 'partial');
      assert.equal(project.nodes.filter((n) => n.kind === 'bridge-api').length, 1);
    }
    const duplicate = await submit(`another-${name}`, body);
    assert.equal(duplicate.status.status, 'succeeded');
    assert.equal(duplicate.status.cacheHit, true);
    assert.equal(duplicate.status.projectId, status.projectId);
  }
  // A cached .NET result is not a valid ASAR parse, even with the exact same hash.
  const renamed = await submit('renamed.asar', managed);
  assert.equal(renamed.status.status, 'failed');
  assert.equal((await fetch(`${origin}/api/jobs/${renamed.ticket.jobId}/project`, {
    headers: { Authorization: `Bearer ${renamed.ticket.jobToken}` },
  })).status, 409);
});
