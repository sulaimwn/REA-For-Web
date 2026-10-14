// Test the real pinned proxy against an inert private echo server. No real env,
// credentials, uploads, production containers, DNS or HTTPS settings are used.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = async (...args) => (await promisify(execFile)('docker', args,
  { cwd: root, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 })).stdout.trim();
const compose = await readFile(join(root, 'deploy/linux/compose.yml'), 'utf8');
const dockerfile = await readFile(join(root, 'deploy/linux/Dockerfile.web'), 'utf8');
const caddy = compose.match(/image: (caddy:\S+)/u)?.[1];
const node = dockerfile.match(/^FROM (node:\S+)/u)?.[1];
assert.ok(caddy && node, 'Use the deployment image pins.');
const id = `rea-proxy-test-${randomUUID()}`;
const containers = [];
let networkCreated = false;
try {
  await run('network', 'create', id);
  networkCreated = true;
  const echo = `require('node:http').createServer((req,res)=>{req.on('error',()=>{});req.on('end',()=>{res.setHeader('Strict-Transport-Security','max-age=0');res.setHeader('X-Content-Type-Options','bad');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.headers));});req.resume();}).listen(3000,'0.0.0.0')`;
  containers.push(await run('run', '-d', '--name', `${id}-web`, '--network', id, '--network-alias', 'web',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '64m',
    '--pids-limit', '32', node, 'node', '-e', echo));
  containers.push(await run('run', '-d', '--name', `${id}-proxy`, '--network', id,
    '-p', '127.0.0.1::80', '-e', 'UPLOAD_HOST=http://localhost',
    '--mount', `type=bind,source=${join(root, 'deploy/linux/Caddyfile')},target=/etc/caddy/Caddyfile,readonly`,
    caddy, 'caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'));
  const [proxy] = JSON.parse(await run('inspect', containers[1]));
  const [binding] = proxy.NetworkSettings.Ports['80/tcp'];
  assert.equal(binding.HostIp, '127.0.0.1');
  const url = `http://localhost:${binding.HostPort}/upload`;
  let response;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      response = await fetch(url, { headers: {
        'X-REA-Client-IP': '198.51.100.123', 'X-Forwarded-For': '198.51.100.124',
        'CF-Connecting-IP': '198.51.100.125' }, signal: AbortSignal.timeout(1000) });
      if (response.ok && response.headers.get('Content-Type')?.includes('application/json')) break;
      await response.body?.cancel();
    } catch { /* Only the bounded startup probe retries. */ }
    await delay(100);
  }
  assert.equal(response?.status, 200);
  assert.match(response.headers.get('Content-Type') ?? '', /application\/json/u);
  const headers = await response.json();
  assert.ok(isIP(headers['x-rea-client-ip']));
  assert.ok(!['198.51.100.123', '198.51.100.124', '198.51.100.125'].includes(headers['x-rea-client-ip']),
    'Client-supplied headers cannot choose the quota identity.');
  assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=31536000');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  const large = await fetch(url, { method: 'POST',
    body: Buffer.alloc(2 * 1024 * 1024), signal: AbortSignal.timeout(5000) });
  assert.equal(large.status, 413, 'Small metadata body limit remains active.');
  await large.body?.cancel();
  console.log('Upload proxy: forged IP overwritten, security headers enforced, metadata limit retained.');
} finally {
  for (const container of containers.reverse()) await run('rm', '-f', container);
  if (networkCreated) await run('network', 'rm', id);
}
