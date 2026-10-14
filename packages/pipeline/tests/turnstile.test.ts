import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyChallenge } from '../src/turnstile.js';
const config = { siteKey: 'test-site', secret: 'private-test-secret', hostname: 'uploads.example.com' };
const response = (value: unknown) => async () => Response.json(value);
test('challenge verification accepts only server-confirmed exact hostname and action, with no IP disclosure', async () => {
  await verifyChallenge('token', config, async (url, options) => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(options?.redirect, 'error');
    const body = options?.body as URLSearchParams;
    assert.equal(body.get('secret'), config.secret);
    assert.equal(body.get('response'), 'token');
    assert.equal(body.has('remoteip'), false);
    return Response.json({ success: true, hostname: config.hostname, action: 'upload-app' });
  });
  for (const value of [{ success: false }, { success: true, hostname: 'forged.example', action: 'upload-app' },
    { success: true, hostname: config.hostname, action: 'another-form' }, { success: 'true', hostname: config.hostname, action: 'upload-app' }])
    await assert.rejects(verifyChallenge('token', config, response(value)), /security check/u);
  await assert.rejects(verifyChallenge(null, config));
  await assert.rejects(verifyChallenge('x'.repeat(2049), config));
});
test('challenge deadlines cover stalled headers and body; malformed or oversized replies fail closed', async () => {
  await assert.rejects(verifyChallenge('token', config, () => new Promise<Response>(() => {}), 20), /unavailable/u);
  await assert.rejects(verifyChallenge('token', config, async () => new Response(new ReadableStream({ start() {} })), 20), /unavailable/u);
  await assert.rejects(verifyChallenge('token', config, async () => new Response('not json')), /unavailable/u);
  await assert.rejects(verifyChallenge('token', config, async () => new Response('x'.repeat(8193))), /unavailable/u);
});
