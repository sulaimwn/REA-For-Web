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
// Options for apps that ship unbundled dependencies (T031):
//   --drop-unknown-under <prefix>  drop REA `unknown` nodes whose key path starts with <prefix>, e.g.
//                                  node_modules/ (counted under _fixture_trim, not drawn as gaps)
//   --keep-limitations <n>         keep the first n limitation strings (the rest are counted)
//   --cap-coverage-unknown-ids     cap each semantic coverage family's unknown_ids list like other arrays
//
// Usage: node trim-fixture.mjs <in.json> <out.json> [--keep-modules 300] [--keep-semantic 200]
//        [--drop-unknown-under node_modules/] [--keep-limitations 100] [--cap-coverage-unknown-ids]
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const [inFile, outFile] = args;
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : Number(args[i + 1]);
};
const keepModules = opt('--keep-modules', 300);
const keepSemantic = opt('--keep-semantic', 200);
const keepLimitations = opt('--keep-limitations', Infinity);
const dropUnder = (() => {
  const i = args.indexOf('--drop-unknown-under');
  return i === -1 ? null : args[i + 1];
})();

const MODULE_KINDS = new Set(['javascript-module', 'source-module', 'javascript-asset', 'javascript-chunk', 'source-map', 'artifact']);

const doc = JSON.parse(readFileSync(inFile, 'utf8'));
const r = doc.normalized_result;
const g = r.graph;
// The key of an `unknown` node names the file it is about, e.g. `project-javascript-application:node_modules/x/y.js`.
const unknownPath = (n) => String(n.identity?.key ?? '').replace(/^[^:]*:/u, '');
const nodesOriginal = g.nodes.length;
const edgesOriginal = g.edges.length;
const droppedUnknown = dropUnder === null ? [] : g.nodes.filter((n) => n.kind === 'unknown' && unknownPath(n).startsWith(dropUnder));
if (droppedUnknown.length) {
  const dropped = new Set(droppedUnknown.map((n) => n.node_id));
  g.nodes = g.nodes.filter((n) => !dropped.has(n.node_id));
  g.edges = g.edges.filter((e) => !dropped.has(e.source_node_id) && !dropped.has(e.target_node_id));
}

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
// `asar-entry` nodes (one per archived file, .asar inputs only) don't seed the search; afterwards an entry
// is kept only if the file it maps to was kept, so a trimmed .asar sample keeps its folding intact.
const keptIds = new Set(g.nodes.filter((n) => !MODULE_KINDS.has(n.kind) && n.kind !== 'asar-entry').map((n) => n.node_id));
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
for (const e of g.edges) {
  if (e.relation === 'maps_to' && kindOf.get(e.source_node_id) === 'asar-entry' && keptIds.has(e.target_node_id)) keptIds.add(e.source_node_id);
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

// Coverage families list every unknown id they cover; with --cap-coverage-unknown-ids keep the first
// keepSemantic of each (off by default so earlier trimmed fixtures regenerate unchanged).
const unknownIdsOriginal = {};
for (const family of args.includes('--cap-coverage-unknown-ids') && Array.isArray(sg.coverage?.families) ? sg.coverage.families : []) {
  if (Array.isArray(family.unknown_ids) && family.unknown_ids.length > keepSemantic) {
    unknownIdsOriginal[family.family] = family.unknown_ids.length;
    family.unknown_ids = family.unknown_ids.slice(0, keepSemantic);
  }
}
const limitationsOriginal = Array.isArray(r.limitations) ? r.limitations.length : 0;
if (Array.isArray(r.limitations) && r.limitations.length > keepLimitations) r.limitations = r.limitations.slice(0, keepLimitations);

doc._fixture_trim = {
  note: 'Trimmed by fixtures/tools/trim-fixture.mjs. Structure is real; arrays are subsets. Evidence hashes no longer verify.',
  graph: {
    nodes_original: nodesOriginal,
    nodes_kept: keptNodes.length,
    edges_original: edgesOriginal,
    edges_kept: keptEdges.length,
    rule: `all non-module nodes kept; up to ${keepModules} module-like nodes (${[...MODULE_KINDS].join(', ')}) kept, chosen breadth-first from non-module nodes; edges kept only when both ends kept`,
  },
  semantic_graph: {
    arrays_truncated_to: keepSemantic, original_lengths: semanticCounts,
    ...(Object.keys(unknownIdsOriginal).length ? { coverage_family_unknown_ids_original: unknownIdsOriginal } : {}),
  },
  ...(droppedUnknown.length ? { dropped_unknown: { under: dropUnder, count: droppedUnknown.length } } : {}),
  ...(limitationsOriginal > r.limitations?.length ? { limitations: { original: limitationsOriginal, kept: r.limitations.length } } : {}),
};
g.nodes = keptNodes;
g.edges = keptEdges;

writeFileSync(outFile, JSON.stringify(doc));
console.log(JSON.stringify(doc._fixture_trim, null, 2));
