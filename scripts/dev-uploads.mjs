// Local development only: a loopback Redis container, private local objects,
// trusted queue process, and the Next.js app. Targets only reach the REA sandbox.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { assertQueueIdentity } from '../apps/worker/src/queue-identity.ts';

assertQueueIdentity();
const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.UPLOAD_DEV_PORT ?? 3104),
  redisPort = Number(process.env.UPLOAD_REDIS_PORT ?? 6380);
if (
  !Number.isInteger(port) ||
  !Number.isInteger(redisPort) ||
  port < 1024 ||
  port > 65535 ||
  redisPort < 1024 ||
  redisPort > 65535
)
  throw new Error('Invalid local port.');
const container = `rea-studio-upload-redis-${redisPort}`;
// Preserve the original default volume; alternate ports get isolated queue data.
const redisVolume = redisPort === 6380 ? 'rea-studio-upload-redis' : container;
const nativeWorker = process.env.REA_NATIVE_WORKER ?? '1';
if (!['0', '1'].includes(nativeWorker)) throw new Error('REA_NATIVE_WORKER must be 0 or 1.');
function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}
const data = join(root, '.pipeline-data');
await mkdir(data, { recursive: true });
const secretPath = join(data, 'upload-secret');
let secret;
try {
  secret = await readFile(secretPath, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  secret = randomBytes(32).toString('hex');
  await writeFile(secretPath, secret, { flag: 'wx', mode: 0o600 });
}
const env = {
  ...process.env,
  PIPELINE_STORAGE: 'local',
  PIPELINE_PUBLIC_ORIGIN: `http://localhost:${port}`,
  REDIS_URL: `redis://127.0.0.1:${redisPort}`,
  PIPELINE_DATA_ROOT: join(data, 'objects'),
  PIPELINE_WORK_ROOT: join(root, '.pipeline-work'),
  PIPELINE_UPLOAD_SECRET: secret,
  REA_NATIVE_WORKER: nativeWorker,
};
await run(process.execPath, [process.env.npm_execpath, 'run', 'build']);
await run('docker', [
  'build',
  '-f',
  'apps/worker/Dockerfile',
  '-t',
  'rea-studio-worker:rea-6.8.0',
  '.',
]);
if (nativeWorker === '1') await run('docker', [
  'build', '-f', 'apps/worker/Dockerfile.native', '-t', 'rea-studio-worker-native:rea-6.8.0', '.',
]);
await run('docker', [
  'run',
  '--detach',
  '--rm',
  '--name',
  container,
  '--publish',
  `127.0.0.1:${redisPort}:6379`,
  '--mount',
  `type=volume,source=${redisVolume},target=/data`,
  'redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499',
  'redis-server',
  '--appendonly',
  'yes',
  '--maxmemory-policy',
  'noeviction',
]);
let worker,
  web,
  closing = false;
async function close() {
  if (closing) return;
  closing = true;
  worker?.kill('SIGTERM');
  web?.kill('SIGTERM');
  await run('docker', ['stop', container]).catch(() => {});
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
worker = spawn(process.execPath, [join(root, 'apps/worker/dist/queue.js')], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: true,
});
web = spawn(
  process.execPath,
  [
    join(root, 'node_modules/next/dist/bin/next'),
    'start',
    'apps/web',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
  ],
  { cwd: root, env, stdio: 'inherit', windowsHide: true },
);
for (const child of [worker, web]) {
  child.on('error', () => void close());
  child.on('exit', () => void close());
}
console.log(
  `Uploads are available at http://localhost:${port}/upload. Ctrl+C stops the local services; Redis data is preserved.`,
);
