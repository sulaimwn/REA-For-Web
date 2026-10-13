// Regenerates the non-Electron REA fixtures from the committed sample binaries.
// Each fixture is one JSON object keyed by REA operation name, holding that command's
// unmodified output envelope (local paths scrubbed to <INPUT_PATH>/<INPUT_DIR>).
//
// Usage: REA_SCRIPT=<path to node_modules/rea-agents/scripts/rea.mjs> node fixtures/tools/target-fixtures.mjs
// REA only reads the samples; nothing here runs them.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REA_VERSION = '6.4.0';
const reaScript = process.env.REA_SCRIPT;
if (!reaScript) throw new Error('Set REA_SCRIPT to rea-agents/scripts/rea.mjs (rea-agents@6.4.0).');
const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function rea(args) {
  const r = spawnSync(process.execPath, [reaScript, ...args, '--format', 'json'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.error) throw r.error;
  const text = r.stdout ?? '';
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`rea ${args[0]}: no JSON output (exit ${r.status}): ${r.stderr}`);
  const value = JSON.parse(text.slice(start));
  if (value.error) throw new Error(`rea ${args[0]} failed: ${value.code}: ${value.message}`);
  return value;
}

/** Replaces the sample's absolute path and folder, in both slash styles, everywhere in the JSON. */
function scrub(value, inputPath) {
  let s = JSON.stringify(value);
  // Escaped once (a JSON string) and twice (JSON text inside a JSON string, as JADX tool responses are).
  const escape = (v) => JSON.stringify(v).slice(1, -1);
  const variants = (p) => [p, p.replaceAll('\\', '/')].flatMap((v) => [escape(escape(v)), escape(v)]);
  for (const v of variants(inputPath)) s = s.split(v).join('<INPUT_PATH>');
  for (const v of variants(dirname(inputPath))) s = s.split(v).join('<INPUT_DIR>');
  // Provider runs (JADX) also report their working copy, JAR and JDK locations.
  for (const [path, label] of [[process.env.REA_JADX_MCP_JAR, '<JADX_JAR>'], [process.env.JAVA_HOME, '<JAVA_HOME>'], [tmpdir(), '<TEMP>']]) {
    if (path) for (const v of variants(path)) s = s.split(v).join(label);
  }
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home && s.includes(JSON.stringify(home).slice(1, -1))) throw new Error('A local home path survived scrubbing.');
  return JSON.parse(s);
}

/** Projection commands take their input as inline JSON or a file path; inputs exceed Windows' argument limit, so use a file. */
function reaWithInput(command, input) {
  const dir = mkdtempSync(join(tmpdir(), 'rea-fixture-'));
  try {
    const file = join(dir, 'input.json');
    writeFileSync(file, JSON.stringify(input));
    return rea([command, file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function write(name, inputPath, bundle) {
  const out = join(fixtures, 'samples', `${name}.rea-${REA_VERSION}.json`);
  writeFileSync(out, `${JSON.stringify(scrub(bundle, inputPath))}\n`);
  console.log(`wrote ${out}`);
}

// .NET: three static inspections, then REA's own projection of them into an application graph.
{
  const exe = join(fixtures, 'sample-apps', 'tiny-dotnet', 'TinyNotes.exe');
  const managed_artifact = rea(['inspect-managed-artifact', exe]);
  const managed_members = rea(['inspect-managed-members', exe]);
  const managed_native_boundaries = rea(['inspect-managed-native-boundaries', exe]);
  const graph = reaWithInput('project-managed-application-graph', { managed_artifact, managed_members, managed_native_boundaries });
  write('tiny-dotnet', exe, {
    inspect_managed_artifact: managed_artifact,
    inspect_managed_members: managed_members,
    inspect_managed_native_boundaries: managed_native_boundaries,
    project_managed_application_graph: graph,
  });
}

// Android: REA's JADX provider in one MCP session (REA_JADX_MCP_JAR = jadx-headless-mcp 0.7.1, plus a JDK),
// using the adapter's collector: package and manifest, the app's classes, each method decompiled, references.
// Without the JAR, REA only inventories the APK's files, which has no adapter.
if (process.env.REA_JADX_MCP_JAR) {
  const apk = join(fixtures, 'sample-apps', 'tiny-android', 'tiny-notes.apk');
  const { collectAndroidBundle } = await import(new URL('../../packages/rea-adapter/dist/android-session.js', import.meta.url).href);
  write('tiny-android', apk, await collectAndroidBundle({ reaScript, apk }));
}

// Native: REA's Ghidra provider in one MCP session (GHIDRA_INSTALL_DIR = Ghidra 12.1.x, plus JDK 21),
// using the adapter's collector (shared by the CLI and the worker) so the fixture is exactly what they read.
// Needs `npm run build -w @rea-studio/rea-adapter` first.
if (process.env.GHIDRA_INSTALL_DIR) {
  const exe = join(fixtures, 'sample-apps', 'tiny-native', 'tiny-notes.exe');
  const { collectNativeBundle } = await import(new URL('../../packages/rea-adapter/dist/native-session.js', import.meta.url).href);
  const bundle = await collectNativeBundle({ reaScript, program: exe });
  write('tiny-native', exe, JSON.parse(JSON.stringify(bundle).split(JSON.stringify(process.env.GHIDRA_INSTALL_DIR).slice(1, -1)).join('<GHIDRA_INSTALL_DIR>')));
}

// Linux ELF: REA's Ghidra provider accepts only PE programs on a Windows host, so collect inside the
// native worker image (Linux), with the same adapter collector. Set NATIVE_IMAGE=1 after building
// apps/worker/Dockerfile.native. The container has no network and only reads the sample.
if (process.env.NATIVE_IMAGE === '1') {
  const dir = join(fixtures, 'sample-apps', 'tiny-linux');
  const out = mkdtempSync(join(tmpdir(), 'rea-fixture-'));
  try {
    const r = spawnSync('docker', [
      'run', '--rm', '--network=none', '--cpus=1', '--memory=2g', '--workdir=/tmp', '--env=HOME=/tmp',
      '--mount', `type=bind,source=${dir},target=/input,readonly`,
      '--mount', `type=bind,source=${join(fixtures, 'tools')},target=/tools,readonly`,
      '--mount', `type=bind,source=${out},target=/out`,
      '--entrypoint', 'node', 'rea-studio-worker-native:rea-6.4.0', '/tools/collect-native-in-image.mjs', 'tiny-notes',
    ], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    if (r.status !== 0) throw new Error(`native image collection failed: ${r.stderr}`);
    const bundle = JSON.parse(readFileSync(join(out, 'bundle.json'), 'utf8'));
    // Paths inside the container: scrub the same way as host paths.
    write('tiny-linux', '/input/tiny-notes', bundle);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
