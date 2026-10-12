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
