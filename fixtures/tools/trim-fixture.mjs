// Trims a large REA analyze-javascript-application output into a committable sample.
//
// Keeps: the full envelope, summary, statistics, limitations, coverage, every
// application-graph node that is NOT a module/asset/source-map, up to
// --keep-modules module-like nodes nearest to those, and every edge whose two
// ends were kept.
// Semantic graph: keeps metadata/coverage and the first --keep-semantic items of
// each array. Original counts are recorded under `_fixture_trim`.
//
// Trimming changes bytes covered by REA's evidence hashes; trimmed files will not
// pass REA's own validation. Use them for adapter/UI development only.
//
// Usage: node trim-fixture.mjs <in.json> <out.json> [--keep-modules 300] [--keep-semantic 200]
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const [inFile, outFile] = args;
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : Number(args[i + 1]);
};
const keepModules = opt('--keep-modules', 300);
const keepSemantic = opt('--keep-semantic', 200);

const MODULE_KINDS = new Set(['javascript-module', 'source-module', 'javascript-asset', 'javascript-chunk', 'source-map', 'artifact']);

const doc = JSON.parse(readFileSync(inFile, 'utf8'));
const r = doc.normalized_result;
const g = r.graph;

// Pick module-like nodes breadth-first outward from the non-module nodes, so the
// sample stays a connected graph instead of an arbitrary slice.
const kindOf = new Map(g.nodes.map((n) => [n.node_id, n.kind]));
const neighbors = new Map();
for (const e of g.edges) {
  for (const [a, b] of [[e.source_node_id, e.target_node_id], [e.target_node_id, e.source_node_id]]) {
    if (!neighbors.has(a)) neighbors.set(a, []);
    neighbors.get(a).push(b);
  }
}
const keptIds = new Set(g.nodes.filter((n) => !MODULE_KINDS.has(n.kind)).map((n) => n.node_id));
let frontier = [...keptIds];
let moduleBudget = keepModules;
while (frontier.length && moduleBudget > 0) {
  const next = [];
  for (const id of frontier) {
    for (const nb of neighbors.get(id) ?? []) {
      if (moduleBudget > 0 && !keptIds.has(nb) && MODULE_KINDS.has(kindOf.get(nb))) {
        keptIds.add(nb);
        next.push(nb);
        moduleBudget--;
      }
    }
  }
  frontier = next;
}
const keptNodes = g.nodes.filter((n) => keptIds.has(n.node_id));
const keptEdges = g.edges.filter((e) => keptIds.has(e.source_node_id) && keptIds.has(e.target_node_id));

const sg = r.semantic_graph;
const semanticCounts = {};
for (const [k, v] of Object.entries(sg)) {
  if (Array.isArray(v) && v.length > keepSemantic) {
    semanticCounts[k] = v.length;
    sg[k] = v.slice(0, keepSemantic);
  }
}

doc._fixture_trim = {
  note: 'Trimmed by fixtures/tools/trim-fixture.mjs. Structure is real; arrays are subsets. Evidence hashes no longer verify.',
  graph: {
    nodes_original: g.nodes.length,
    nodes_kept: keptNodes.length,
    edges_original: g.edges.length,
    edges_kept: keptEdges.length,
    rule: `all non-module nodes kept; up to ${keepModules} module-like nodes (${[...MODULE_KINDS].join(', ')}) kept, chosen breadth-first from non-module nodes; edges kept only when both ends kept`,
  },
  semantic_graph: { arrays_truncated_to: keepSemantic, original_lengths: semanticCounts },
};
g.nodes = keptNodes;
g.edges = keptEdges;

writeFileSync(outFile, JSON.stringify(doc));
console.log(JSON.stringify(doc._fixture_trim, null, 2));
