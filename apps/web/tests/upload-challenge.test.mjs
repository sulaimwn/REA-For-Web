import test from 'node:test';
import assert from 'node:assert/strict';
import { requestUploadChallenge } from '../lib/upload-challenge.ts';

test('each retry renders a fresh upload check and removes its widget after success', async t => {
  const previous = globalThis.window;
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  let calls = 0;
  const removed = [];
  globalThis.window = { turnstile: {
    render(_container, options) {
      assert.equal(options.sitekey, 'public-key');
      assert.equal(options.action, 'upload-app');
      const id = String(++calls);
      queueMicrotask(() => options.callback(`fresh-${id}`));
      return id;
    }, remove(id) { removed.push(id); },
  } };
  assert.equal(await requestUploadChallenge({}, 'public-key', new AbortController().signal), 'fresh-1');
  assert.equal(await requestUploadChallenge({}, 'public-key', new AbortController().signal), 'fresh-2');
  assert.deepEqual(removed, ['1', '2']);
});

test('cancellation and expiry reject the check and clean up without accepting late callbacks', async t => {
  const previous = globalThis.window;
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const removed = [];
  let options;
  globalThis.window = { turnstile: {
    render(_container, value) { options = value; return 'widget'; }, remove(id) { removed.push(id); },
  } };
  const controller = new AbortController();
  const pending = requestUploadChallenge({}, 'public-key', controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /aborted/u);
  options.callback('too-late');
  const expired = requestUploadChallenge({}, 'public-key', new AbortController().signal);
  await new Promise(resolve => setImmediate(resolve));
  options['expired-callback']();
  await assert.rejects(expired, /expired/u);
  assert.deepEqual(removed, ['widget', 'widget']);
});

test('script failure is recoverable, and a pre-cancelled request never loads the widget', async t => {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  });
  globalThis.window = {};
  let scripts = 0;
  globalThis.document = {
    createElement() { return { remove() {} }; },
    head: { appendChild(script) {
      scripts++;
      assert.equal(script.src, 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
      queueMicrotask(() => script.onerror());
    } },
  };
  await assert.rejects(requestUploadChallenge({}, 'public-key', new AbortController().signal), /could not load/u);
  await assert.rejects(requestUploadChallenge({}, 'public-key', new AbortController().signal), /could not load/u);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(requestUploadChallenge({}, 'public-key', cancelled.signal));
  assert.equal(scripts, 2);
});
