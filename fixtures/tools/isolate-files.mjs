// T008 fixtures: analyze single files of an app on their own, the way recovery does (the file,
// its .map and the root package.json at the same relative paths in an empty folder), and save
// REA's output with the temporary folder scrubbed to <INPUT_PATH>.
//
// Usage: REA_SCRIPT=<rea-agents/scripts/rea.mjs> node fixtures/tools/isolate-files.mjs <app dir> <name> <file>...
// Writes fixtures/samples/<name>.isolated.<file with / as __>.rea-6.4.0.json. REA only reads the files.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const reaScript = process.env.REA_SCRIPT;
if (!reaScript) throw new Error('Set REA_SCRIPT to rea-agents/scripts/rea.mjs (rea-agents@6.4.0).');
const [app, name, ...files] = process.argv.slice(2);
if (!app || !name || files.length === 0) throw new Error('Usage: isolate-files.mjs <app dir> <name> <file>...');
const samples = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'samples');

for (const rel of files) {
  const work = mkdtempSync(join(tmpdir(), 'rea-isolate-'));
  try {
    for (const r of ['package.json', rel, `${rel}.map`]) {
      if (!existsSync(join(app, r))) continue;
      mkdirSync(dirname(join(work, r)), { recursive: true });
      copyFileSync(join(app, r), join(work, r));
    }
    const r = spawnSync(process.execPath, [reaScript, 'analyze-javascript-application', work, '--format', 'json'], { encoding: 'utf8', maxBuffer: 1024 ** 3 });
    if (r.error) throw r.error;
    let text = r.stdout.slice(r.stdout.indexOf('{'));
    for (const v of [work, work.replaceAll('\\', '/')].map((p) => JSON.stringify(p).slice(1, -1))) text = text.split(v).join('<INPUT_PATH>');
    const home = process.env.USERPROFILE ?? process.env.HOME;
    if (home && text.includes(JSON.stringify(home).slice(1, -1))) throw new Error(`A local home path survived scrubbing in ${rel}.`);
    JSON.parse(text);
    const out = join(samples, `${name}.isolated.${rel.replaceAll('/', '__')}.rea-6.4.0.json`);
    writeFileSync(out, `${text.trim()}\n`);
    console.log(`wrote ${out} (${(text.length / 1024).toFixed(0)} KB)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
