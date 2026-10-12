// Replaces absolute local input paths in a REA JSON output with <INPUT_PATH>.
// Note: this changes bytes covered by REA's evidence hashes, so scrubbed
// fixtures will not pass REA's own evidence validation. Fine for UI/adapter dev.
// Usage: node scrub-paths.mjs <in.json> <out.json> <absolute-input-path>
import { readFileSync, writeFileSync } from 'node:fs';

const [inFile, outFile, inputPath] = process.argv.slice(2);
let s = readFileSync(inFile, 'utf8');
const variants = new Set([
  JSON.stringify(inputPath).slice(1, -1),
  JSON.stringify(inputPath.replaceAll('/', '\\')).slice(1, -1),
]);
let n = 0;
for (const v of variants) {
  n += s.split(v).length - 1;
  s = s.split(v).join('<INPUT_PATH>');
}
JSON.parse(s);
writeFileSync(outFile, s);
console.log(`replaced ${n} occurrence(s)`);
