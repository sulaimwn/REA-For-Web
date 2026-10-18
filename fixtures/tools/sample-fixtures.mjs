// Generates REA fixtures for the real-world sample projects (T031) from downloaded, checksum-verified
// copies. The apps are only read by REA; nothing here runs them. See fixtures/sample-apps/real-world.md for
// sources, versions and SHA-256s.
//
// Usage (each step runs only when its input is given):
//   REA_SCRIPT=<rea-agents/scripts/rea.mjs> \
//   CAPRINE_ASAR=<app.asar from caprine_2.61.0_amd64.deb> \
//   JQ_EXE=<jq-windows-amd64.exe 1.8.2>  GHIDRA_INSTALL_DIR=… JAVA_HOME=… \
//   JQ_MACOS=<jq-macos-amd64 1.8.2>  (collected inside the native worker image; REA's Windows Ghidra is PE-only) \
//   BINARYEYE_APK=<de.markusfisch.android.binaryeye_180.apk>  REA_JADX_MCP_JAR=… \
//   node fixtures/tools/sample-fixtures.mjs
// Needs `npm run build:packages` first (the native and Android collectors live in the adapter).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REA_VERSION = '6.7.0';
const reaScript = process.env.REA_SCRIPT;
if (!reaScript) throw new Error('Set REA_SCRIPT to rea-agents/scripts/rea.mjs (rea-agents@6.7.0).');
const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED = {
  caprine: null, // app.asar is extracted from the .deb, whose SHA-256 is recorded in real-world.md
  jq: 'a6fc67fedaf9128a3309a1e2ebb8b986aeccf70122ee46d2cb4849e423f0c627',
  'jq-macos': 'e94b266e3c26690550006abe63152b782280f4e14374accdf04cbde844f00bc0',
  binaryeye: '568cec6598dbf42fbde9071af8747071ffea798473016a3d77b6ddb3bff944f1',
};

function verify(name, path) {
  const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (EXPECTED[name] && sha !== EXPECTED[name]) throw new Error(`${name}: SHA-256 ${sha} doesn't match the recorded ${EXPECTED[name]}`);
  console.log(`${name}: ${sha}`);
}

/** Replaces local paths (input, its folder, providers, temp, home) everywhere in the JSON. */
function scrub(value, inputPath) {
  let s = JSON.stringify(value);
  const escape = (v) => JSON.stringify(v).slice(1, -1);
  const variants = (p) => [p, p.replaceAll('\\', '/')].flatMap((v) => [escape(escape(v)), escape(v)]);
  for (const [path, label] of [
    [inputPath, '<INPUT_PATH>'], [dirname(inputPath), '<INPUT_DIR>'],
    [process.env.REA_JADX_MCP_JAR, '<JADX_JAR>'], [process.env.GHIDRA_INSTALL_DIR, '<GHIDRA_INSTALL_DIR>'],
    [process.env.JAVA_HOME, '<JAVA_HOME>'], [tmpdir(), '<TEMP>'],
  ]) if (path) for (const v of variants(path)) s = s.split(v).join(label);
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home && s.includes(JSON.stringify(home).slice(1, -1))) throw new Error('A local home path survived scrubbing.');
  return JSON.parse(s);
}

function write(name, inputPath, bundle) {
  const out = join(fixtures, 'samples', `${name}.rea-${REA_VERSION}.json`);
  writeFileSync(out, `${JSON.stringify(scrub(bundle, inputPath))}\n`);
  console.log(`wrote ${out}`);
}

const timed = async (label, fn) => {
  const started = Date.now();
  const result = await fn();
  console.log(`${label}: ${Math.round((Date.now() - started) / 1000)} s`);
  return result;
};

if (process.env.CAPRINE_ASAR) {
  const asar = resolve(process.env.CAPRINE_ASAR);
  verify('caprine', asar);
  const raw = await timed('caprine analysis', () => {
    const r = spawnSync(process.execPath, [reaScript, 'analyze-javascript-application', asar, '--artifact-format', 'asar', '--format', 'json'],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
    const text = r.stdout ?? '';
    const start = text.indexOf('{');
    if (start === -1) throw new Error(`caprine: no JSON output (exit ${r.status}): ${(r.stderr ?? '').slice(-500)}`);
    return JSON.parse(text.slice(start));
  });
  // REA's full output is ~184 MB (Caprine ships unbundled node_modules): write it to temp, then commit a
  // trimmed sample (gaps inside node_modules counted, not drawn), like the GitHub Desktop fixture.
  const full = join(tmpdir(), `caprine-${process.pid}.rea.json`);
  writeFileSync(full, JSON.stringify(scrub(raw, asar)));
  const out = join(fixtures, 'samples', `caprine-2.61.0.trimmed.rea-${REA_VERSION}.json`);
  const trim = spawnSync(process.execPath, ['--max-old-space-size=6144', join(fixtures, 'tools', 'trim-fixture.mjs'), full, out,
    '--keep-modules', '400', '--keep-semantic', '200', '--drop-unknown-under', 'node_modules/', '--keep-limitations', '100', '--cap-coverage-unknown-ids'],
  { encoding: 'utf8' });
  rmSync(full, { force: true });
  if (trim.status !== 0) throw new Error(`trim failed: ${trim.stderr}`);
  console.log(`wrote ${out}`);
}

if (process.env.JQ_EXE) {
  const exe = resolve(process.env.JQ_EXE);
  verify('jq', exe);
  const { collectNativeBundle } = await import(new URL('../../packages/rea-adapter/dist/native-session.js', import.meta.url).href);
  const bundle = await timed('jq collection', () => collectNativeBundle({ reaScript, program: exe, onProgress: (m) => console.log(`  ${m}`) }));
  write('jq-1.8.2-windows', exe, bundle);
}

// macOS Mach-O: like Linux ELF, REA's Ghidra provider only accepts it on a Linux/macOS host, so collect inside
// the native worker image (no network, the sample mounted read-only). Needs apps/worker/Dockerfile.native built.
if (process.env.JQ_MACOS) {
  const program = resolve(process.env.JQ_MACOS);
  verify('jq-macos', program);
  const out = mkdtempSync(join(tmpdir(), 'rea-fixture-'));
  try {
    const r = await timed('jq (macOS) collection', () => spawnSync('docker', [
      'run', '--rm', '--network=none', '--cpus=1', '--memory=2g', '--workdir=/tmp', '--env=HOME=/tmp',
      '--mount', `type=bind,source=${dirname(program)},target=/input,readonly`,
      '--mount', `type=bind,source=${join(fixtures, 'tools')},target=/tools,readonly`,
      '--mount', `type=bind,source=${out},target=/out`,
      '--entrypoint', 'node', 'rea-studio-worker-native:rea-6.7.0', '/tools/collect-native-in-image.mjs', basename(program),
    ], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }));
    if (r.status !== 0) throw new Error(`native image collection failed: ${r.stderr}`);
    // Paths inside the container: scrub the same way as host paths.
    write('jq-1.8.2-macos', `/input/${basename(program)}`, JSON.parse(readFileSync(join(out, 'bundle.json'), 'utf8')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (process.env.BINARYEYE_APK) {
  const apk = resolve(process.env.BINARYEYE_APK);
  verify('binaryeye', apk);
  const { collectAndroidBundle } = await import(new URL('../../packages/rea-adapter/dist/android-session.js', import.meta.url).href);
  const bundle = await timed('binaryeye collection', () => collectAndroidBundle({ reaScript, apk, onProgress: (m) => console.log(`  ${m}`) }));
  write('binaryeye-1.75.5', apk, bundle);
}
