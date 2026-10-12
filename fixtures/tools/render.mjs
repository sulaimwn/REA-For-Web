// Renders REA's JavaScriptApplicationGraph as readable lines using observation labels.
import { readFileSync } from 'node:fs';
const [file, mode = 'all'] = process.argv.slice(2);
const r = JSON.parse(readFileSync(file, 'utf8')).normalized_result;
const g = r.graph;
const byId = Object.fromEntries(g.nodes.map(n => [n.node_id, n]));
const lbl = n => {
  if (!n) return '?';
  const o = n.observations?.[0];
  const p = o?.properties ?? {};
  const name = o?.label ?? p.path ?? p.specifier ?? p.name ?? n.identity?.sha256?.slice(0, 8);
  return `[${n.kind}] ${name}`;
};
if (mode === 'nodes' || mode === 'all') {
  for (const n of g.nodes) console.log(lbl(n), (n.observations?.length ?? 0) > 1 ? `(x${n.observations.length} obs)` : '');
}
if (mode === 'edges' || mode === 'all') {
  console.log('---');
  for (const e of g.edges) {
    const loc = e.evidence?.location?.value;
    const at = loc?.source ? ` @ ${loc.source}:${loc.start?.line ?? ''}` : '';
    console.log(`${lbl(byId[e.source_node_id])}  --${e.relation}-->  ${lbl(byId[e.target_node_id])}  {${e.evidence?.state}/${e.evidence?.confidence}}${at}`);
  }
}
