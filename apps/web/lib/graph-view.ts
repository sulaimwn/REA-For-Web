// Chooses which part of the project graph to draw, and lays it out with dagre.
// Never draws the whole graph: real apps have thousands of nodes.
import { Graph, layout } from '@dagrejs/dagre';
import type { Relation, StudioEdge, StudioNode } from '@rea-studio/schema';
import type { Edge, Node } from '@xyflow/react';
import { KIND_META, KIND_ORDER, type ProjectIndex } from './project';

export type Focus =
  | { mode: 'overview' }
  | { mode: 'node'; id: string }
  /** A chosen set of nodes, e.g. the ones an Ask answer cites. */
  | { mode: 'set'; ids: string[]; label: string };

export interface KindNodeData extends Record<string, unknown> {
  node: StudioNode;
  focused: boolean;
  /** Layout direction of the node's component; decides where edge handles sit. */
  dir: Dir;
}

export type Dir = 'TB' | 'LR';

export interface ViewGraph {
  nodes: Node<KindNodeData>[];
  edges: Edge[];
  /** Neighbors left out to keep the view readable. */
  hidden: number;
}

const NODE_W = 230;
const NODE_H = 54;
const MAX_NEIGHBORS = 60;
const IPC_RELATIONS: ReadonlySet<Relation> = new Set(['sends', 'invokes', 'handles']);

function edgesOf(ix: ProjectIndex, id: string): StudioEdge[] {
  return [...(ix.outgoing.get(id) ?? []), ...(ix.incoming.get(id) ?? [])];
}

/** `contains` edges from the artifact root connect everything to everything; they're noise in a view. */
function isRootContainment(ix: ProjectIndex, e: StudioEdge) {
  return e.relation === 'contains' && e.source === ix.rootId;
}

/** Most nodes the overview draws; big .NET programs have thousands of methods. */
const OVERVIEW_LIMIT = 250;

function overviewIds(ix: ProjectIndex): { ids: Set<string>; hidden: number } {
  const core = ix.project.nodes.filter((n) => KIND_META[n.kind].overview).map((n) => n.id);
  const ids = new Set(core);
  for (const id of core) {
    for (const e of edgesOf(ix, id)) {
      if (isRootContainment(ix, e)) continue;
      const other = e.source === id ? e.target : e.source;
      const kind = ix.byId.get(other)?.kind;
      if (kind === 'file' || kind === 'module' || kind === 'package') ids.add(other);
    }
  }
  if (ids.size <= OVERVIEW_LIMIT) return { ids, hidden: 0 };
  // Keep the most architectural kinds (KIND_ORDER) and say how many were left out.
  const rank = (id: string) => KIND_ORDER.indexOf(ix.byId.get(id)?.kind ?? 'analysis-gap');
  const kept = [...ids].sort((a, b) => rank(a) - rank(b)).slice(0, OVERVIEW_LIMIT);
  return { ids: new Set(kept), hidden: ids.size - OVERVIEW_LIMIT };
}

function neighborhoodIds(ix: ProjectIndex, focusId: string): { ids: Set<string>; hidden: number } {
  const ranked = new Map<string, number>(); // neighbor → rank (lower shows first)
  for (const e of edgesOf(ix, focusId)) {
    if (focusId !== ix.rootId && isRootContainment(ix, e)) continue;
    const other = e.source === focusId ? e.target : e.source;
    const n = ix.byId.get(other);
    if (!n) continue;
    const rank = (e.relation === 'contains' ? 100 : 0) + KIND_ORDER.indexOf(n.kind);
    ranked.set(other, Math.min(rank, ranked.get(other) ?? Infinity));
  }
  const sorted = [...ranked.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  return { ids: new Set([focusId, ...sorted.slice(0, MAX_NEIGHBORS)]), hidden: Math.max(0, sorted.length - MAX_NEIGHBORS) };
}

interface Block {
  w: number;
  h: number;
  dir: Dir;
  /** Top-left positions relative to the block. */
  pos: Map<string, { x: number; y: number }>;
}

const GAP = 60;

/** Lays out one connected component, in whichever direction comes out closer to square. */
function dagreBlock(ids: string[], edges: StudioEdge[]): Block {
  const tb = dagreBlockDir(ids, edges, 'TB');
  if (ids.length < 6) return tb;
  const lr = dagreBlockDir(ids, edges, 'LR');
  const skew = (b: Block) => Math.max(b.w / b.h, b.h / b.w);
  return skew(lr) < skew(tb) ? lr : tb;
}

function dagreBlockDir(ids: string[], edges: StudioEdge[], dir: Dir): Block {
  const g = new Graph();
  g.setGraph(dir === 'TB' ? { rankdir: 'TB', nodesep: 24, ranksep: 60 } : { rankdir: 'LR', nodesep: 14, ranksep: 90 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of ids) g.setNode(id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);
  layout(g);
  const pos = new Map<string, { x: number; y: number }>();
  let w = 0;
  let h = 0;
  for (const id of ids) {
    const p = g.node(id) as { x: number; y: number };
    const x = p.x - NODE_W / 2;
    const y = p.y - NODE_H / 2;
    pos.set(id, { x, y });
    w = Math.max(w, x + NODE_W);
    h = Math.max(h, y + NODE_H);
  }
  return { w, h, dir, pos };
}

/** Lays out unconnected nodes as a grid, grouped by kind. */
function gridBlock(ix: ProjectIndex, ids: string[]): Block {
  const order = (id: string) => KIND_ORDER.indexOf(ix.byId.get(id)?.kind ?? 'analysis-gap');
  const sorted = [...ids].sort((a, b) => order(a) - order(b));
  // Roughly square on screen: nodes are much wider than tall.
  const cols = Math.max(1, Math.ceil(Math.sqrt((sorted.length * (NODE_H + 20)) / (NODE_W + 24))));
  const pos = new Map<string, { x: number; y: number }>();
  sorted.forEach((id, i) => pos.set(id, { x: (i % cols) * (NODE_W + 24), y: Math.floor(i / cols) * (NODE_H + 20) }));
  const rows = Math.ceil(sorted.length / cols);
  return { w: cols * (NODE_W + 24) - 24, h: rows * (NODE_H + 20) - 20, dir: 'TB', pos };
}

/**
 * Dagre lines up disconnected components in one long row, which is unreadable
 * for real apps. Lay out each connected component separately, put lone nodes
 * in a grid, then shelf-pack the blocks into rows of a roughly square area.
 */
function layoutPacked(ix: ProjectIndex, ids: string[], edges: StudioEdge[]): Map<string, { x: number; y: number; dir: Dir }> {
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    adj.get(e.source)?.push(e.target);
    adj.get(e.target)?.push(e.source);
  }
  const seen = new Set<string>();
  const components: string[][] = [];
  const singles: string[] = [];
  for (const start of ids) {
    if (seen.has(start)) continue;
    const comp: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const id = stack.pop() as string;
      comp.push(id);
      for (const nb of adj.get(id) ?? []) if (!seen.has(nb)) (seen.add(nb), stack.push(nb));
    }
    if (comp.length === 1) singles.push(start);
    else components.push(comp);
  }

  const blocks: Block[] = components.map((comp) => {
    const set = new Set(comp);
    return dagreBlock(comp, edges.filter((e) => set.has(e.source)));
  });
  if (singles.length) blocks.push(gridBlock(ix, singles));
  blocks.sort((a, b) => b.h - a.h);

  const area = blocks.reduce((s, b) => s + (b.w + GAP) * (b.h + GAP), 0);
  const rowWidth = Math.max(Math.sqrt(area) * 1.4, ...blocks.map((b) => b.w));
  const out = new Map<string, { x: number; y: number; dir: Dir }>();
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const b of blocks) {
    if (x > 0 && x + b.w > rowWidth) {
      x = 0;
      y += rowH + GAP;
      rowH = 0;
    }
    for (const [id, p] of b.pos) out.set(id, { x: x + p.x, y: y + p.y, dir: b.dir });
    x += b.w + GAP;
    rowH = Math.max(rowH, b.h);
  }
  return out;
}

/**
 * A focused node's neighborhood is a star; dagre turns big stars into one
 * endless column. Instead: incoming neighbors in a grid on the left, the focus
 * in the middle, outgoing neighbors in a grid on the right (grouped by kind).
 */
function layoutHub(ix: ProjectIndex, focusId: string, ids: Set<string>, edges: StudioEdge[]): Map<string, { x: number; y: number; dir: Dir }> {
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  for (const e of edges) {
    if (e.target === focusId && e.source !== focusId) incoming.add(e.source);
    if (e.source === focusId && e.target !== focusId) outgoing.add(e.target);
  }
  for (const id of incoming) if (outgoing.has(id)) incoming.delete(id);
  // Neighbors linked only through other neighbors still need a place.
  for (const id of ids) if (id !== focusId && !incoming.has(id)) outgoing.add(id);

  const left = gridBlock(ix, [...incoming]);
  const right = gridBlock(ix, [...outgoing]);
  const height = Math.max(left.h, right.h, NODE_H);
  const out = new Map<string, { x: number; y: number; dir: Dir }>();
  const leftW = incoming.size ? left.w + 2 * GAP : 0;
  for (const [id, p] of left.pos) out.set(id, { x: p.x, y: (height - left.h) / 2 + p.y, dir: 'LR' });
  out.set(focusId, { x: leftW, y: (height - NODE_H) / 2, dir: 'LR' });
  for (const [id, p] of right.pos) out.set(id, { x: leftW + NODE_W + 2 * GAP + p.x, y: (height - right.h) / 2 + p.y, dir: 'LR' });
  return out;
}

export function buildView(ix: ProjectIndex, focus: Focus): ViewGraph {
  const { ids, hidden } =
    focus.mode === 'overview'
      ? overviewIds(ix)
      : focus.mode === 'set'
        ? { ids: new Set(focus.ids.filter((id) => ix.byId.has(id))), hidden: 0 }
        : neighborhoodIds(ix, focus.id);

  // Collapse parallel REA edges (same endpoints + relation) into one drawn edge.
  const groups = new Map<string, StudioEdge[]>();
  for (const e of ix.project.edges) {
    if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue;
    if (isRootContainment(ix, e) && !(focus.mode === 'node' && focus.id === ix.rootId)) continue;
    const key = `${e.source}|${e.target}|${e.relation}|${e.origin.source}`;
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }

  const pairs = [...groups.values()].map((list) => list[0] as StudioEdge);
  const positions = focus.mode === 'node' ? layoutHub(ix, focus.id, ids, pairs) : layoutPacked(ix, [...ids], pairs);

  const focusedId = focus.mode === 'node' ? focus.id : null;
  const nodes: Node<KindNodeData>[] = [];
  for (const id of ids) {
    const n = ix.byId.get(id);
    const pos = positions.get(id);
    if (!n || !pos) continue;
    // initialWidth/Height: the minimap only draws nodes whose size it knows.
    nodes.push({ id, type: 'kind', position: { x: pos.x, y: pos.y }, initialWidth: NODE_W, initialHeight: NODE_H, data: { node: n, focused: id === focusedId, dir: pos.dir } });
  }

  const edges: Edge[] = [...groups.values()].map((list) => {
    const first = list[0] as StudioEdge;
    const observed = list.some((e) => e.evidence.state === 'observed');
    const heuristic = list.every((e) => e.origin.source === 'studio-heuristic');
    const ipc = IPC_RELATIONS.has(first.relation);
    return {
      id: `${first.source}|${first.target}|${first.relation}|${first.origin.source}`,
      source: first.source,
      target: first.target,
      label: `${list.length > 1 ? `${first.relation} ×${list.length}` : first.relation}${heuristic ? ' (heuristic)' : ''}`,
      // IPC is drawn in the boundary color, not animated: motion only follows the user's actions.
      className: `rel ${ipc ? 'rel-ipc' : ''} ${heuristic ? 'rel-heuristic' : ''} ${observed ? 'rel-observed' : 'rel-inferred'}`,
    };
  });

  return { nodes, edges, hidden };
}
