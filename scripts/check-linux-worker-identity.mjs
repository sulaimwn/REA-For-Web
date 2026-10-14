// Real Linux ownership checks with inert bytes. No queue, credentials or uploaded program.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_USER } from '../apps/worker/dist/limits.js';
import { assertEngine } from '../apps/worker/dist/run-analysis.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const image = (await readFile(join(root, 'apps/worker/Dockerfile'), 'utf8')).split(/\s/u)[1];
assert.match(image ?? '', /^node:[a-zA-Z0-9._-]+@sha256:[a-f0-9]{64}$/u);
assert.equal(WORKER_USER, '1000:1000', 'Update this ownership regression if the reviewed sandbox identity changes.');
const limits = join(root, 'apps/worker/dist/limits.js');
assert.ok(!limits.includes(','), 'Docker mount paths for this check must not contain commas.');
const id = `rea-identity-${randomBytes(6).toString('hex')}`;
const volume = `${id}-data`;
const label = 'rea-studio.identity-check';
const exec = promisify(execFile);
const docker = async (args) => (await exec('docker', args, {
  windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024,
})).stdout.trim();
const containers = [];
let created = false;
async function run(user, source, { writable = false, chown = false } = {}) {
  const name = `${id}-${containers.length}`;
  containers.push(name);
  return docker(['run', '--rm', '--pull=never', '--name', name, '--label', `${label}=${id}`,
    '--network=none', '--user', user, '--read-only', '--cap-drop=ALL',
    ...(chown ? ['--cap-add=CHOWN'] : []),
    '--security-opt=no-new-privileges=true', '--pids-limit=32', '--cpus=1',
    '--memory=128m', '--memory-swap=128m',
    '--mount', `type=volume,source=${volume},target=/data${writable ? '' : ',readonly'}`,
    '--mount', `type=bind,source=${limits},target=/opt/worker-limits.mjs,readonly`,
    image, 'node', '--input-type=module', '-e', source]);
}
const probe = `
  import {stat,readFile} from 'node:fs/promises';
  import {assertQueueIdentity} from '/opt/worker-limits.mjs';
  const info=await stat('/data/target.macho');
  let identityAccepted=true, identityError, bytes, readError;
  try {assertQueueIdentity();} catch(e) {identityAccepted=false;identityError=e.message;}
  try {bytes=(await readFile('/data/target.macho')).length;} catch(e) {readError=e.code;}
  console.log(JSON.stringify({uid:process.getuid(),euid:process.geteuid(),fileUid:info.uid,fileGid:info.gid,mode:info.mode&0o777,
    identityAccepted,identityError,bytes,readError}));
`;
try {
  assertEngine(JSON.parse(await docker(['info', '--format', '{{json .}}'])));
  await docker(['image', 'inspect', image]); // The build caches its pinned base; do not pull on a test's behalf.
  await docker(['volume', 'create', '--label', `${label}=${id}`, volume]);
  created = true;
  // A root administrative helper sets up only this test volume's inert inode.
  // CHOWN is needed for fixture ownership; it is never added to analysis jobs.
  await run('0:0', `import {writeFile,chown} from 'node:fs/promises';
    await writeFile('/data/target.macho','inert permission probe; never a program',{mode:0o600});
    await chown('/data/target.macho',1001,1001);`, {writable:true,chown:true});
  const service = JSON.parse(await run('1001:1001', probe));
  assert.equal(service.identityAccepted, false);
  assert.equal(service.euid, 1001);
  assert.match(service.identityError, /UID 1000/u);
  assert.equal(service.bytes, 39, 'The mismatched host user can read its own private file.');
  const refused = JSON.parse(await run(WORKER_USER, probe));
  assert.equal(refused.identityAccepted, true);
  assert.equal(refused.fileUid, 1001);
  assert.equal(refused.mode, 0o600);
  assert.equal(refused.readError, 'EACCES', 'The actual sandbox UID cannot read the mismatched private inode.');
  // Change only ownership. The primary group may differ; mode 0600 stays private.
  await run('0:0', `import {chown} from 'node:fs/promises'; await chown('/data/target.macho',1000,1001);`, {writable:true,chown:true});
  const aligned = JSON.parse(await run(WORKER_USER, probe));
  assert.equal(aligned.identityAccepted, true);
  assert.equal(aligned.uid, 1000);
  assert.equal(aligned.euid, 1000);
  assert.equal(aligned.fileUid, 1000);
  assert.equal(aligned.fileGid, 1001);
  assert.equal(aligned.mode, 0o600);
  assert.equal(aligned.bytes, 39);
  assert.equal(aligned.readError, undefined);
  console.log('Linux ownership checks passed: mismatched queue UID rejected; private input unreadable until UID aligns; mode 0600 unchanged.');
} finally {
  for (const name of containers) {
    let info;
    try { [info] = JSON.parse(await docker(['inspect', name])); }
    catch (error) {
      if (/No such (?:object|container)/iu.test(error.stderr ?? '')) continue;
      throw error;
    }
    assert.equal(info.Config.Labels[label], id, 'Never remove an unrelated container.');
    await docker(['rm', '--force', name]);
  }
  if (created) {
    const [info] = JSON.parse(await docker(['volume', 'inspect', volume]));
    assert.equal(info.Labels[label], id, 'Never remove an unrelated volume.');
    await docker(['volume', 'rm', volume]);
  }
  console.log('Owned Linux identity containers and volume removed.');
}
