// Indexing and display helpers over a StudioProject. UI code only; no REA types here.
import type { StudioEdge, StudioNode, StudioNodeKind, StudioProject } from '@rea-studio/schema';

export interface DemoEntry {
  slug: string;
  title: string;
  blurb: string;
  name: string;
  version: string | null;
  /** `StudioProject.target.appKind`; lets the MCP endpoint list demos without loading them. */
  appKind: string;
  nodes: number;
  edges: number;
  coverage: string;
  sample: string | null;
  /** Number of published guided tours (see scripts/generate-tours.mjs). */
  tours: number;
}

/** A pre-generated Ask answer shipped with a demo. */
export interface Tour {
  question: string;
  answer: string;
  citedNodeIds: string[];
  steps: { name: string; input: unknown }[];
  model: string;
}

/**
 * Kinds are drawn by family, each with its own shape and color, so they stay
 * distinguishable without color: runtime ■, boundary ◆, system ●, code □, gap (hatched).
 */
export type KindFamily = 'runtime' | 'boundary' | 'system' | 'code' | 'gap';

export interface KindMeta {
  label: string;
  plural: string;
  family: KindFamily;
  /** Shown in the architecture overview graph. */
  overview: boolean;
}

export const KIND_META: Record<StudioNodeKind, KindMeta> = {
  process: { label: 'Process', plural: 'Processes', family: 'runtime', overview: true },
  window: { label: 'Window', plural: 'Windows', family: 'runtime', overview: true },
  'bridge-api': { label: 'Bridge API', plural: 'Bridge APIs', family: 'boundary', overview: true },
  'ipc-channel': { label: 'IPC channel', plural: 'IPC channels', family: 'boundary', overview: true },
  'ipc-handler': { label: 'IPC handler', plural: 'IPC handlers', family: 'boundary', overview: true },
  'native-addon': { label: 'Native add-on', plural: 'Native add-ons', family: 'system', overview: true },
  storage: { label: 'Storage key', plural: 'Storage', family: 'system', overview: true },
  worker: { label: 'Worker', plural: 'Workers', family: 'runtime', overview: true },
  endpoint: { label: 'Endpoint candidate', plural: 'Endpoint candidates', family: 'system', overview: false },
  package: { label: 'Package', plural: 'Packages', family: 'code', overview: false },
  file: { label: 'File', plural: 'Shipped files', family: 'code', overview: false },
  module: { label: 'Module', plural: 'Modules', family: 'code', overview: false },
  'external-module': { label: 'External module', plural: 'External modules', family: 'code', overview: false },
  'bundle-chunk': { label: 'Bundle chunk', plural: 'Bundle chunks', family: 'code', overview: false },
  'source-file': { label: 'Source file', plural: 'Source files', family: 'code', overview: false },
  'source-map': { label: 'Source map', plural: 'Source maps', family: 'code', overview: false },
  'analysis-gap': { label: 'Analysis gap', plural: 'Analysis gaps', family: 'gap', overview: false },
};

/** Which kinds to show first in grids and neighborhoods. Noisy, unfiltered kinds go last. */
export const KIND_ORDER: readonly StudioNodeKind[] = [
  'process', 'window', 'bridge-api', 'ipc-channel', 'ipc-handler', 'native-addon', 'worker', 'storage',
  'package', 'file', 'module', 'bundle-chunk', 'external-module', 'source-map', 'source-file', 'endpoint', 'analysis-gap',
];


export interface ProjectIndex {
  project: StudioProject;
  byId: Map<string, StudioNode>;
  outgoing: Map<string, StudioEdge[]>;
  incoming: Map<string, StudioEdge[]>;
  byKind: Map<StudioNodeKind, StudioNode[]>;
  /** The artifact root `file` node (path ''), which `contains` almost everything. */
  rootId: string | null;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function indexProject(project: StudioProject): ProjectIndex {
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, StudioEdge[]>();
  const incoming = new Map<string, StudioEdge[]>();
  const byKind = new Map<StudioNodeKind, StudioNode[]>();
  for (const e of project.edges) {
    pushTo(outgoing, e.source, e);
    pushTo(incoming, e.target, e);
  }
  for (const n of project.nodes) pushTo(byKind, n.kind, n);
  const root = project.nodes.find((n) => n.kind === 'file' && n.path === '');
  return { project, byId, outgoing, incoming, byKind, rootId: root?.id ?? null };
}

/** A short, human label for a node. REA labels are sometimes internal (e.g. `BrowserWindow@6:14-13:4`). */
export function displayName(n: StudioNode): string {
  switch (n.kind) {
    case 'ipc-channel':
      return n.channel ?? `dynamic channel (${n.channelExpression ?? '?'})`;
    case 'ipc-handler':
      return `${n.operation}(${n.channel ?? n.channelExpression ?? '?'})`;
    case 'window':
      return `BrowserWindow in ${basename(n.sourcePath)}`;
    case 'process':
      return `${n.role}: ${n.path}`;
    case 'bridge-api':
      return `window.${n.apiKey ?? '?'}`;
    case 'storage':
      return n.name ?? `${n.storageKind} (key not resolved)`;
    case 'worker':
      return n.resolvedPath ?? n.expression ?? 'worker';
    case 'file':
      return n.path === '' ? 'artifact root' : n.path;
    case 'endpoint':
      return n.value.trim() === '' ? '(blank value)' : n.value;
    case 'analysis-gap':
      return n.path || n.label;
    case 'source-file':
    case 'module':
    case 'native-addon':
    case 'bundle-chunk':
      return n.path;
    case 'source-map':
      return n.path ?? n.label;
    case 'external-module':
      return n.specifier;
    case 'package':
      return `${n.name}${n.version ? `@${n.version}` : ''}`;
  }
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Text a search query matches against. */
export function searchText(n: StudioNode): string {
  return `${displayName(n)} ${n.label} ${KIND_META[n.kind].label}`.toLowerCase();
}
