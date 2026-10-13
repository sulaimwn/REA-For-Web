import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { openPage } from '../src/browser.js';

test('browser startup errors reject promptly instead of crashing or hanging', { timeout: 10000 }, async () => {
  await assert.rejects(openPage(join(import.meta.dirname, 'missing-browser-binary'), 'http://localhost/'), /could not start/);
});
test('an early browser exit is handled without waiting for an already-delivered exit event', { timeout: 10000 }, async () => {
  await assert.rejects(openPage(process.execPath, 'http://localhost/'), /exited before/);
});
