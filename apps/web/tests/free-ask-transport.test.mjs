import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FreeAskUnavailableError } from '@rea-studio/ask/free';
import { createFreeChat, freeAskEndpoint } from '../lib/free-ask-transport.ts';

describe('Free Ask browser transport', () => {
  it('routes uploads and loopback development to Cloudflare while other sites keep their own service', () => {
    for (const origin of ['https://uploads.reaforweb.com', 'http://localhost:3103', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      assert.equal(freeAskEndpoint(origin), 'https://reaforweb.com/api/ask/free');
    }
    for (const origin of ['https://reaforweb.com', 'https://www.reaforweb.com', 'https://a-fork.example',
      'http://localhost.evil.example:3000', 'http://user@localhost:3000', 'null']) {
      assert.equal(freeAskEndpoint(origin), '/api/ask/free');
    }
  });

  it('sends only the conversation without cookies or a private job URL, and preserves cancellation', async () => {
    const controller = new AbortController();
    const request = { messages: [{ role: 'user', content: 'How does this app work?' }], final: false };
    const calls = [];
    const chat = createFreeChat('https://uploads.reaforweb.com', async (url, init) => {
      calls.push({ url, init });
      return Response.json({ response: 'Answer.', tool_calls: [] });
    });
    assert.deepEqual(await chat(request, controller.signal), { response: 'Answer.', tool_calls: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://reaforweb.com/api/ask/free');
    assert.equal(calls[0].init.credentials, 'omit');
    assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
    assert.equal(calls[0].init.cache, 'no-store');
    assert.equal(calls[0].init.signal, controller.signal);
    assert.deepEqual(calls[0].init.headers, { 'content-type': 'application/json' });
    assert.deepEqual(JSON.parse(calls[0].init.body), request);
  });

  it('preserves allowance and service failures without silently changing to a paid model', async () => {
    for (const status of [403, 429, 503]) {
      const chat = createFreeChat('http://localhost:3103', async () => Response.json({ message: 'Free limit.' }, { status }));
      await assert.rejects(chat({ messages: [], final: false }), error => error instanceof FreeAskUnavailableError && error.message === 'Free limit.');
    }
    const failed = createFreeChat('https://reaforweb.com', async () => Response.json({ message: 'Model unavailable.' }, { status: 502 }));
    await assert.rejects(failed({ messages: [], final: false }), /Model unavailable/u);
  });
});
