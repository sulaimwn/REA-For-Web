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
  // .NET (T021): the assembly is the runnable unit; P/Invoke is where managed code crosses into native code.
  assembly: { label: '.NET assembly', plural: 'Assemblies', family: 'runtime', overview: true },
  'managed-type': { label: 'Type', plural: 'Types', family: 'code', overview: true },
  'managed-method': { label: 'Method', plural: 'Methods', family: 'code', overview: true },
  'native-import': { label: 'Native library call', plural: 'Native library calls', family: 'boundary', overview: true },
  'external-member': { label: 'External API', plural: 'External APIs', family: 'system', overview: false },
  // Native programs (T021): functions found by Ghidra; their imports are `native-import` (boundary).
  'native-function': { label: 'Function', plural: 'Functions', family: 'code', overview: true },
  // Android (T021): manifest components are the app's runnable parts; permissions are what it asks for.
  'android-component': { label: 'App component', plural: 'Components', family: 'runtime', overview: true },
  'android-permission': { label: 'Permission', plural: 'Permissions', family: 'system', overview: false },
  'analysis-gap': { label: 'Analysis gap', plural: 'Analysis gaps', family: 'gap', overview: false },
};

/** Which kinds to show first in grids and neighborhoods. Noisy, unfiltered kinds go last. */
export const KIND_ORDER: readonly StudioNodeKind[] = [
  'process', 'android-component', 'window', 'bridge-api', 'ipc-channel', 'ipc-handler', 'native-addon', 'worker', 'storage',
  'assembly', 'native-import', 'managed-type', 'managed-method', 'native-function', 'android-permission',
  'package', 'file', 'module', 'bundle-chunk', 'external-module', 'external-member', 'source-map', 'source-file', 'endpoint', 'analysis-gap',
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
      // A website's root is its page; show the URL (T021).
      return n.path === '' ? (/^https?:\/\//u.test(n.label) ? n.label : 'artifact root') : n.path;
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
    case 'assembly':
      return `${n.name}${n.version ? ` ${n.version}` : ''}`;
    case 'managed-type':
      return n.fullName;
    case 'managed-method':
      return `${shortType(n.declaringType)}.${n.name}`;
    case 'native-import':
      // The function first: graph cards truncate, and `/usr/lib/libSystem.B.dylib!…` would hide it.
      return n.library ? `${n.entryPoint} (${basename(n.library)})` : n.entryPoint;
    case 'external-member':
      return `${n.name}(${n.parameterTypes.join(', ')})`;
    case 'native-function':
      return n.name;
    case 'android-component':
      return n.className.split('.').pop() ?? n.className;
    case 'android-permission':
      return n.name.replace(/^android\.permission\./u, '');
  }
}

/** `TinyNotes.NoteStore` → `NoteStore`, keeping compiler-made names such as `<PushAsync>d__0` intact. */
function shortType(fullName: string): string {
  if (fullName.startsWith('<')) return fullName;
  const i = fullName.lastIndexOf('.');
  return i === -1 ? fullName : fullName.slice(i + 1);
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** An REA endpoint candidate Studio's `endpoint-shape` heuristic judged unlikely (T012). Hidden by default, never removed. */
export function isUnlikelyEndpoint(n: StudioNode): boolean {
  return n.kind === 'endpoint' && n.assessment?.verdict === 'unlikely';
}

/** Text a search query matches against. */
export function searchText(n: StudioNode): string {
  return `${displayName(n)} ${n.label} ${KIND_META[n.kind].label}`.toLowerCase();
}
