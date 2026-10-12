// Prints the structural shape of a JSON file: key paths, types, array lengths, byte share.
import { readFileSync } from 'node:fs';
const [file, maxDepth = '4'] = process.argv.slice(2);
const root = JSON.parse(readFileSync(file, 'utf8'));
const total = JSON.stringify(root).length;
function walk(v, path, depth) {
  const size = JSON.stringify(v)?.length ?? 0;
  const pct = ((size / total) * 100).toFixed(1).padStart(5);
  if (Array.isArray(v)) {
    console.log(`${pct}%  ${path}  [${v.length}]`);
    if (depth < +maxDepth && v.length) {
      // union of keys across up to 200 elements
      const sample = v.slice(0, 200);
      if (sample.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
        const merged = {};
        for (const x of sample) for (const k of Object.keys(x)) merged[k] ??= x[k];
        walk(merged, path + '[]', depth + 1);
      } else walk(v[0], path + '[0]', depth + 1);
    }
  } else if (v && typeof v === 'object') {
    console.log(`${pct}%  ${path}  {${Object.keys(v).length}}`);
    if (depth < +maxDepth) for (const [k, c] of Object.entries(v)) walk(c, `${path}.${k}`, depth + 1);
  } else {
    const s = JSON.stringify(v); console.log(`${pct}%  ${path} = ${s.length > 70 ? s.slice(0, 70) + '…' : s}`);
  }
}
walk(root, '$', 0);
