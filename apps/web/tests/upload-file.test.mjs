import assert from 'node:assert/strict';
import { it } from 'node:test';
import { uploadFile } from '../lib/upload-file.ts';

class Request {
  upload = {};
  status = 200;
  headers = {};
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(name, value) { this.headers[name] = value; }
  send(file) { this.file = file; }
  abort() { this.aborted = true; this.onabort?.(); }
}

it('reports bytes but waits for successful HTTP completion before resolving', async () => {
  const request = new Request();
  const file = new File(['abcd'], 'test.asar');
  const seen = [];
  let done = false;
  const pending = uploadFile('/signed', { 'Content-Type': 'application/octet-stream' }, file, new AbortController().signal,
    (loaded, total) => seen.push([loaded, total]), () => request).then(() => { done = true; });
  request.upload.onprogress({ loaded: 2 });
  request.upload.onprogress({ loaded: 4 });
  await Promise.resolve();
  assert.equal(done, false);
  assert.deepEqual(seen, [[2, 4], [4, 4]]);
  assert.equal(request.method, 'PUT');
  assert.equal(request.file, file);
  request.onload();
  await pending;
  assert.equal(done, true);
  assert.equal(request.upload.onprogress, null);
});

it('aborts the transfer on cancellation and reports server or network failures', async () => {
  for (const mode of ['cancel', 'server', 'network', 'timeout']) {
    const request = new Request();
    const controller = new AbortController();
    const pending = uploadFile('/signed', {}, new File(['x'], 'test.asar'), controller.signal, () => {}, () => request);
    const rejected = assert.rejects(pending);
    if (mode === 'cancel') controller.abort();
    else if (mode === 'server') { request.status = 403; request.onload(); }
    else if (mode === 'network') request.onerror();
    else request.ontimeout();
    await rejected;
    if (mode === 'cancel') assert.equal(request.aborted, true);
    assert.equal(request.onload, null);
  }
});

it('does not start a transfer when the page is already cancelled', async () => {
  await assert.rejects(uploadFile('/signed', {}, new File(['x'], 'test.asar'), AbortSignal.abort(), () => {},
    () => { throw new Error('should never construct a request'); }));
});
