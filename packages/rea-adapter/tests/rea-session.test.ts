import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openReaSession } from '../src/rea-session.js';

const reaScript = fileURLToPath(new URL('../../tests/helpers/fake-rea-protocol.mjs', import.meta.url));
const options = (mode: string) => ({ reaScript, maxMessageBytes: 512, env: { ...process.env, FAKE_REA_MODE: mode } });

describe('bounded REA MCP transport', () => {
  for (const [mode, error] of [
    ['oversize-line', /exceeded its size limit/],
    ['oversize-fragment', /exceeded its size limit/],
    ['null', /invalid JSON-RPC/],
    ['bad-utf8', /invalid UTF-8/],
    ['invalid-result', /invalid MCP tool result/],
  ] as const) {
    it(`rejects ${mode} without crashing the host`, { timeout: 5000 }, async () => {
      const session = await openReaSession(options(mode));
      try { await assert.rejects(session.call('probe'), error); }
      finally { await session.close(); }
    });
  }

  it('rejects invalid limits before starting REA', async () => {
    for (const maxMessageBytes of [0, -1, NaN, Infinity, 1.5]) {
      await assert.rejects(openReaSession({ reaScript, maxMessageBytes }), /positive safe integer/);
    }
  });

  it('closes idempotently and rejects outstanding and later calls', { timeout: 5000 }, async () => {
    const session = await openReaSession(options('pending'));
    const pending = assert.rejects(session.call('probe'), /session is closed/);
    await Promise.all([session.close(), session.close(), pending]);
    await assert.rejects(session.call('later'), /session is closed/);
  });

  it('cleans up when a running session is aborted', { timeout: 5000 }, async () => {
    const controller = new AbortController();
    const session = await openReaSession({ ...options('pending'), signal: controller.signal });
    const pending = assert.rejects(session.call('probe'), /aborted/);
    controller.abort();
    await pending;
    await session.close();
    await assert.rejects(openReaSession({ reaScript, signal: controller.signal }), /aborted/);
  });
});
