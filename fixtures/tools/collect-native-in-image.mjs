// Runs INSIDE the native worker image (rea-studio-worker-native): collects REA's Ghidra bundle for
// /input/<name> with the adapter's collector and writes it to /out/bundle.json. Used for programs that
// REA's Ghidra provider only accepts on Linux/macOS hosts, such as Linux ELF (REA on Windows is PE-only).
// The program is only read by REA; it is never run. See target-fixtures.mjs for the docker invocation.
import { writeFileSync } from 'node:fs';

const name = process.argv[2];
if (!name || /[\\/]/u.test(name)) throw new Error('Usage: collect-native-in-image.mjs <file name under /input>');
const { collectNativeBundle } = await import('/opt/worker/node_modules/@rea-studio/rea-adapter/dist/native-session.js');
const bundle = await collectNativeBundle({
  reaScript: '/opt/rea/node_modules/rea-agents/scripts/rea.mjs',
  program: `/input/${name}`,
  env: { ...process.env, GHIDRA_HEADLESS_MAXMEM: '1024m' },
});
writeFileSync('/out/bundle.json', JSON.stringify(bundle));
