// The tools the model uses to answer questions about one StudioProject.
// Read-only, deterministic, and size-capped. Results are JSON strings.
import type Anthropic from '@anthropic-ai/sdk';
import { NODE_KINDS, type StudioEdge, type StudioNode } from '@rea-studio/schema';
import { evidenceRef, nodeName, nodeRef, searchableText, type ProjectGraph } from './graph.js';

const LIST_CAP = 40;
const MAX_PATH_HOPS = 8;

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false,
});

export const ASK_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'project_overview',
    description:
      'Summary of the analyzed app: name, version, coverage, findings per category (found / not-found, counts, unresolved counts, notes), IPC summary and node counts by kind. Call this first.',
    input_schema: obj({}, []),
    strict: true,
  },
  {
    name: 'search_nodes',
    description:
      'Find nodes whose name, path, label, exports or members contain every word of the query (case-insensitive). Optionally restrict to one node kind. Returns up to 25 matches with ids.',
    input_schema: obj(
      {
        query: { type: 'string', description: 'Words to match, e.g. "clipboard" or "settings store".' },
        kind: { type: 'string', enum: [...NODE_KINDS, 'any'], description: 'Node kind to restrict to, or "any".' },
      },
      ['query', 'kind'],
    ),
    strict: true,
  },
  {
    name: 'get_node',
    description: 'All facts about one node: its kind-specific fields, origin (REA or studio heuristic), evidence (file:line, observed/inferred, confidence, limitations) and link counts.',
    input_schema: obj({ id: { type: 'string', description: 'Node id from another tool result.' } }, ['id']),
    strict: true,
  },
  {
    name: 'get_neighbors',
    description:
      'Links from and/or to a node: relation, direction, the other node, and the link evidence. Use to follow imports, IPC (sends/invokes/handles), loads, storage writes, etc.',
    input_schema: obj(
      {
        id: { type: 'string', description: 'Node id.' },
        direction: { type: 'string', enum: ['out', 'in', 'both'], description: 'Which links to list.' },
      },
      ['id', 'direction'],
    ),
    strict: true,
  },
  {
    name: 'find_path',
    description:
      'Shortest chain of links between two nodes (either direction, up to 8 hops, ignoring the artifact root that contains every file). Use to trace a feature end to end, e.g. renderer file → bridge → IPC channel → handler.',
    input_schema: obj(
      {
        from_id: { type: 'string', description: 'Start node id.' },
        to_id: { type: 'string', description: 'End node id.' },
      },
      ['from_id', 'to_id'],
    ),
    strict: true,
  },
];

function cap<T>(items: T[], limit = LIST_CAP) {
  return items.length > limit ? { items: items.slice(0, limit), omitted: items.length - limit } : { items };
}

const REPORTED_SEPARATELY = new Set(['id', 'label', 'evidence', 'origin']);

/** Kind-specific node fields; id, label, evidence and origin are reported separately. */
function facts(n: StudioNode, appKind: string): Record<string, unknown> {
  const result = Object.fromEntries(
    Object.entries(n)
      .filter(([k]) => !REPORTED_SEPARATELY.has(k))
      .map(([k, v]) => [k, Array.isArray(v) && v.length > LIST_CAP ? [...v.slice(0, LIST_CAP), `… ${v.length - LIST_CAP} more`] : v]),
  );
  if (n.kind === 'managed-type') result['classificationNote'] = 'compilerGenerated is a Studio name-pattern heuristic; false does not prove a type was not compiler-generated.';
  if (n.kind === 'native-function') result['classificationNote'] = 'entryPoint is a Studio symbol-name heuristic, not a verified executable entry address.';
  if (n.kind === 'managed-method' && appKind === 'android') result['classificationNote'] = 'entryPoint is a Studio heuristic for onCreate on the manifest launcher activity; it does not prove runtime execution.';
  return result;
}

function edgeView(g: ProjectGraph, e: StudioEdge, from: string) {
  const outgoing = e.source === from;
  const other = g.byId.get(outgoing ? e.target : e.source);
  return {
    relation: e.relation,
    direction: outgoing ? 'out' : 'in',
    other: other ? nodeRef(other) : null,
    origin: e.origin.source === 'rea' ? 'rea' : `studio-heuristic:${e.origin.heuristic}`,
    evidence: evidenceRef(e.evidence),
    ...(Object.keys(e.details).length ? { details: e.details } : {}),
  };
}

function rootId(g: ProjectGraph): string | undefined {
  return g.project.nodes.find((n) => n.kind === 'file' && n.path === '' || n.kind === 'assembly')?.id;
}

function overview(g: ProjectGraph) {
  const p = g.project;
  const counts: Record<string, number> = {};
  for (const n of p.nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
  return {
    app: p.target,
    analysis: {
      engine: `${p.analysis.engine.package}@${p.analysis.engine.version}`,
      coverage: p.analysis.coverage.status,
      filesWithAnalysisIssues: p.analysis.filesWithAnalysisIssues,
      omitted: p.analysis.omitted,
    },
    findings: p.findings.map((f) => ({ category: f.category, status: f.status, count: f.count, unresolved: f.unresolvedCount, notes: f.notes })),
    ipcSummary: p.ipcSummary,
    nodeCounts: counts,
    edgeCount: p.edges.length,
  };
}

function search(g: ProjectGraph, query: string, kind: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { error: 'Empty query.' };
  const q = query.trim().toLowerCase();
  const hits: { n: StudioNode; score: number }[] = [];
  for (const n of g.project.nodes) {
    if (kind !== 'any' && n.kind !== kind) continue;
    const text = searchableText(n);
    if (!words.every((w) => text.includes(w))) continue;
    const name = nodeName(n).toLowerCase();
    // Real-looking endpoints rank normally; candidates judged unlikely (T012) and gaps rank last.
    const noise = n.kind === 'endpoint' ? (n.assessment?.verdict === 'plausible' ? 0 : 8) : n.kind === 'analysis-gap' ? 5 : 0;
    const score = (name === q ? 0 : name.includes(q) ? 1 : 2) * 10 + noise;
    hits.push({ n, score });
  }
  hits.sort((a, b) => a.score - b.score || nodeName(a.n).length - nodeName(b.n).length);
  return { total: hits.length, matches: hits.slice(0, 25).map((h) => nodeRef(h.n)) };
}

function getNode(g: ProjectGraph, id: string) {
  const n = g.byId.get(id);
  if (!n) return { error: `No node with id ${id}.` };
  return {
    ...nodeRef(n),
    origin: n.origin.source === 'rea' ? 'rea' : `studio-heuristic:${n.origin.heuristic}`,
    facts: facts(n, g.project.target.appKind),
    evidence: cap(n.evidence.map(evidenceRef), 10),
    links: { out: g.outgoing.get(id)?.length ?? 0, in: g.incoming.get(id)?.length ?? 0 },
  };
}

function neighbors(g: ProjectGraph, id: string, direction: string) {
  if (!g.byId.has(id)) return { error: `No node with id ${id}.` };
  const edges = [
    ...(direction !== 'in' ? g.outgoing.get(id) ?? [] : []),
    ...(direction !== 'out' ? g.incoming.get(id) ?? [] : []),
  ];
  // Put meaningful links before bulk containment and noisy endpoint calls.
  const weight = (e: StudioEdge) => (e.relation === 'contains' ? 2 : e.relation === 'calls' && e.origin.source === 'rea' ? 1 : 0);
  edges.sort((a, b) => weight(a) - weight(b));
  return { node: nodeRef(g.byId.get(id) as StudioNode), links: cap(edges.map((e) => edgeView(g, e, id))) };
}

function findPath(g: ProjectGraph, from: string, to: string) {
  if (!g.byId.has(from)) return { error: `No node with id ${from}.` };
  if (!g.byId.has(to)) return { error: `No node with id ${to}.` };
  const root = rootId(g);
  const prev = new Map<string, { node: string; edge: StudioEdge }>();
  const seen = new Set([from]);
  let frontier = [from];
  for (let hop = 0; hop < MAX_PATH_HOPS && frontier.length && !seen.has(to); hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of [...(g.outgoing.get(id) ?? []), ...(g.incoming.get(id) ?? [])]) {
        if (e.source === root || e.target === root) continue;
        const other = e.source === id ? e.target : e.source;
        if (seen.has(other)) continue;
        seen.add(other);
        prev.set(other, { node: id, edge: e });
        next.push(other);
      }
    }
    frontier = next;
  }
  if (!seen.has(to)) return { found: false, note: `No chain of ${MAX_PATH_HOPS} or fewer links found. That does not prove there is none; REA may not have resolved it.` };
  const steps = [];
  for (let at = to; at !== from; ) {
    const step = prev.get(at);
    if (!step) break;
    steps.unshift({ from: nodeRef(g.byId.get(step.node) as StudioNode), ...edgeView(g, step.edge, step.node) });
    at = step.node;
  }
  return { found: true, hops: steps.length, steps };
}

/** Runs one tool call. Unknown tools and bad input produce `{ error }` instead of throwing. */
export function runAskTool(g: ProjectGraph, name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
  let result: unknown;
  switch (name) {
    case 'project_overview':
      result = overview(g);
      break;
    case 'search_nodes':
      result = search(g, str('query'), str('kind') || 'any');
      break;
    case 'get_node':
      result = getNode(g, str('id'));
      break;
    case 'get_neighbors':
      result = neighbors(g, str('id'), str('direction') || 'both');
      break;
    case 'find_path':
      result = findPath(g, str('from_id'), str('to_id'));
      break;
    default:
      result = { error: `Unknown tool ${name}.` };
  }
  const json = JSON.stringify(result);
  if (json.length > 32_000) return JSON.stringify({ error: 'This result is too large. Search for a more specific node or inspect fewer links.', truncated: true });
  return json;
}
