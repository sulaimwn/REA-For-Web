// Test-only Compose project and private local objects. Never contacts a public service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const webPort = Number(process.env.HOST_TEST_WEB_PORT ?? 3116);
const redisPort = Number(process.env.HOST_TEST_REDIS_PORT ?? 6382);
for (const port of [webPort, redisPort]) assert.ok(Number.isSafeInteger(port) && port >= 1024 && port <= 65535);
const temp = await mkdtemp(join(root, '.host-test-'));
const project = `rea-host-test-${randomBytes(6).toString('hex')}`;
const origin = `http://localhost:${webPort}`;
const objects = join(temp, 'objects');
const staging = join(temp, 'staging');
await mkdir(objects, { mode: 0o700 });
await mkdir(staging, { mode: 0o700 });
const common = {
  PIPELINE_STORAGE: 'local', PIPELINE_PUBLIC_ORIGIN: origin,
  PIPELINE_UPLOAD_SECRET: randomBytes(32).toString('hex'),
  PIPELINE_QUEUE_PREFIX: project,
};
const webFile = join(temp, 'web.env');
await writeFile(webFile, Object.entries({ ...common, PIPELINE_DATA_ROOT: '/objects', PIPELINE_WORK_ROOT: '/tmp/staging' }).map(([key,value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
const override = join(temp, 'compose.json');
await writeFile(override, JSON.stringify({ services: { web: { volumes: [{ type: 'bind', source: objects, target: '/objects', bind: { create_host_path: false } }] } } }));
const env = {
  ...process.env, WEB_ENV_FILE: webFile, RELEASE_TAG: process.env.HOST_TEST_RELEASE_TAG ?? 't026',
  UPLOAD_WEB_PORT: String(webPort), QUEUE_REDIS_PORT: String(redisPort),
};
const queueEnv = {
  ...process.env, ...common, PIPELINE_DATA_ROOT: objects, PIPELINE_WORK_ROOT: staging,
  REDIS_URL: `redis://127.0.0.1:${redisPort}`, REA_NATIVE_WORKER: '1',
};
const composeArgs = ['compose', '-p', project, '-f', join(root, 'deploy/linux/compose.yml'), '-f', override];
let queue;
let queueExit;
let composeAttempted = false;
function run(command, args, vars = env, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: vars, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(quiet ? 'Deployment configuration check failed.' : `${command} failed (${code}): ${stderr.slice(-1500)} ${stdout.slice(-1500)}`));
    });
  });
}
const compose = (...args) => run('docker', [...composeArgs, ...args]);
try {
  // Validate silently: resolved Compose output contains environment secrets.
  await run('docker', [...composeArgs, 'config', '--quiet'], env, { quiet: true });
  composeAttempted = true;
  await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '90', 'redis', 'web');
  const webId = (await compose('ps', '-q', 'web')).trim();
  const [web] = JSON.parse(await run('docker', ['inspect', webId]));
  assert.equal(web.Config.User, '1000:1000');
  assert.equal(web.HostConfig.ReadonlyRootfs, true);
  assert.equal(web.HostConfig.Privileged, false);
  assert.ok(web.HostConfig.CapDrop.includes('ALL'));
  assert.ok(web.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  assert.ok(web.Mounts.every(mount => !mount.Destination.includes('docker.sock') && mount.Destination !== '/var/lib/rea-for-web/staging'));
  assert.ok(Object.values(web.HostConfig.PortBindings).flat().every(binding => binding.HostIp === '127.0.0.1'));
  const redisId = (await compose('ps', '-q', 'redis')).trim();
  const [redis] = JSON.parse(await run('docker', ['inspect', redisId]));
  assert.ok(Object.values(redis.HostConfig.PortBindings).flat().every(binding => binding.HostIp === '127.0.0.1'));
  const marker = randomBytes(12).toString('hex');
  await run('docker', ['exec', redisId, 'redis-cli', 'set', 'deployment-check', marker]);
  await compose('restart', 'redis');
  for (let attempt = 0; ; attempt++) {
    try { assert.equal((await run('docker', ['exec', redisId, 'redis-cli', 'get', 'deployment-check'])).trim(), marker); break; }
    catch (error) { if (attempt >= 15) throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  await run(process.execPath, ['deploy/linux/check-worker.mjs'], queueEnv);
  queue = spawn(process.execPath, ['apps/worker/dist/queue.js'], { cwd: root, env: queueEnv, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let queueLog = '';
  queue.stdout.on('data', chunk => { queueLog += chunk; });
  queue.stderr.on('data', chunk => { queueLog += chunk; });
  queueExit = new Promise(resolve => queue.once('close', resolve));
  queue.once('error', error => { queueLog += error.message; });
  for (let attempt = 0; !queueLog.includes('Upload analysis worker ready.'); attempt++) {
    if (attempt >= 60 || queue.exitCode !== null) throw new Error('Queue startup failed.');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const home = await fetch(`${origin}/`);
  assert.equal(home.status, 200);
  assert.ok((await home.text()).includes('Upload your own app'));
  assert.equal((await fetch(`${origin}/projects/tiny-android.json`)).status, 200);
  console.log(`Packaged service ready at ${origin}/upload; testing the real upload flow.`);
  assert.ok(process.env.npm_execpath, 'Run using npm run test:hosted.');
  const testOutput = await run(process.execPath, [process.env.npm_execpath, 'run', 'test:http', '--workspace=@rea-studio/pipeline'], { ...process.env, PIPELINE_TEST_ORIGIN: origin });
  assert.ok(testOutput.includes('pass 2'));
  console.log(testOutput.slice(-1000));
  assert.equal((await readdir(join(objects, 'uploads'))).length, 0);
  assert.equal((await readdir(staging)).length, 0);
  console.log('Packaged service checks passed: web restrictions, private Redis, persistence, host preflight, five analysis kinds and cleanup. Live R2/TLS/systemd are separate operator checks.');
} finally {
  if (queue) {
    queue.kill('SIGTERM');
    const timer = setTimeout(() => queue.kill('SIGKILL'), 15000);
    await queueExit;
    clearTimeout(timer);
  }
  if (composeAttempted) {
    assert.match(project, /^rea-host-test-[a-f0-9]{12}$/);
    await compose('down', '--volumes', '--remove-orphans');
  }
  // This unique, disposable test directory is the only recursive delete target.
  assert.equal(dirname(temp), root.replace(/[\\/]$/, ''));
  assert.ok(basename(temp).startsWith('.host-test-'));
  await rm(temp, { recursive: true, force: true });
}
