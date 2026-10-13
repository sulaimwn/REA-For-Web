import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { it } from 'node:test';
import { pipeBoundedOutput } from '../src/output.js';

it('stops oversized output before writing the chunk that crosses the cap', async () => {
  let written = 0;
  const destination = new Writable({ write(chunk: Buffer, _encoding, callback) { written += chunk.length; callback(); } });
  await assert.rejects(pipeBoundedOutput(Readable.from([Buffer.alloc(4), Buffer.alloc(4)]), destination, 6), /exceeded/);
  assert.equal(written, 4);
});

it('reports disk write failures instead of raising an unhandled stream error', async () => {
  const destination = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('disk full')); } });
  await assert.rejects(pipeBoundedOutput(Readable.from([Buffer.from('data')]), destination, 100), /disk full/);
});
