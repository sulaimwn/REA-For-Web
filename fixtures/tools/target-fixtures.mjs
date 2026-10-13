// Regenerates the non-Electron REA fixtures from the committed sample binaries.
// Each fixture is one JSON object keyed by REA operation name, holding that command's
// unmodified output envelope (local paths scrubbed to <INPUT_PATH>/<INPUT_DIR>).
//
// Usage: REA_SCRIPT=<path to node_modules/rea-agents/scripts/rea.mjs> node fixtures/tools/target-fixtures.mjs
// REA only reads the samples; nothing here runs them.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const variants = (p) => [p, p.replaceAll('\\', '/')].map((v) => JSON.stringify(v).slice(1, -1));
  for (const v of variants(inputPath)) s = s.split(v).join('<INPUT_PATH>');
  for (const v of variants(dirname(inputPath))) s = s.split(v).join('<INPUT_DIR>');
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

// Android: inventory, then REA's inventory-only Android projection (no jadx provider configured).
{
  const apk = join(fixtures, 'sample-apps', 'tiny-android', 'tiny-notes.apk');
  const inventory = rea(['inspect-artifact', apk]);
  const evidence = (inventory.normalized_result?.substeps ?? []).filter((s) => s.operation === 'inventory_artifact' && s.evidence).map((s) => s.evidence);
  const graph = reaWithInput('project-android-application-graph', { inventory_evidence: evidence });
  write('tiny-android', apk, { inspect_artifact: inventory, project_android_application_graph: graph });
}
