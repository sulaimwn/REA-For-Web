// Run on the trusted Linux host with the private worker environment loaded.
// Failures are deliberately generic: never print environment values or Docker stderr.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { configFromEnv, UploadControl } from '../../packages/pipeline/dist/server.js';
import { resultKey } from '../../packages/pipeline/dist/storage.js';
import { assertEngine } from '../../apps/worker/dist/run-analysis.js';
import { WORKER_IMAGE, NATIVE_WORKER_IMAGE, nativeWorkerFromEnv, queueLimitsFromEnv } from '../../apps/worker/dist/limits.js';

const run = promisify(execFile);
const deadline = setTimeout(() => {
  console.error('Worker checks timed out. Check Docker, Redis and storage connectivity.');
  process.exit(1);
}, 35000);
let control;
let stage = 'configuration';
try {
  const config = configFromEnv();
  const limits = queueLimitsFromEnv();
  const native = nativeWorkerFromEnv();
  stage = 'staging permissions';
  if (!isAbsolute(config.workRoot)) throw new Error();
  const work = resolve(config.workRoot);
  const info = await stat(work);
  if (!info.isDirectory()) throw new Error();
  await access(work, constants.R_OK | constants.W_OK | constants.X_OK);
  const docker = async (args) => (await run('docker', args, { timeout: 8000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout;
  stage = 'Docker engine restrictions';
  assertEngine(JSON.parse(await docker(['info', '--format', '{{json .}}'])));
  stage = 'required Docker images';
  await docker(['image', 'inspect', WORKER_IMAGE]);
  if (native) await docker(['image', 'inspect', NATIVE_WORKER_IMAGE]);
  control = new UploadControl(config);
  stage = 'private Redis connection';
  await control.ready();
  // HEAD of an intentionally absent cache key verifies storage authorization without a write.
  stage = 'private object storage';
  await config.store.head(resultKey('0'.repeat(64)));
  console.log(`Worker checks passed: Docker restrictions, pinned images, queue, storage and staging. Job deadline ${limits.timeoutMs / 1000}s; native ${native ? 'enabled' : 'disabled'}.`);
} catch {
  console.error(`Worker checks failed at ${stage}. Check the private configuration and service permissions.`);
  process.exitCode = 1;
} finally {
  try { if (control) await control.close(); }
  catch { process.exitCode = 1; }
  clearTimeout(deadline);
}
