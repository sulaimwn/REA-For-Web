// Read-only index and compact summaries over a StudioProject, for the Ask tools.
import type { Evidence, StudioEdge, StudioNode, StudioProject } from '@rea-studio/schema';

export interface ProjectGraph {
  project: StudioProject;
  byId: Map<string, StudioNode>;
  outgoing: Map<string, StudioEdge[]>;
  incoming: Map<string, StudioEdge[]>;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function indexGraph(project: StudioProject): ProjectGraph {
  const outgoing = new Map<string, StudioEdge[]>();
  const incoming = new Map<string, StudioEdge[]>();
  for (const e of project.edges) {
    pushTo(outgoing, e.source, e);
    pushTo(incoming, e.target, e);
  }
  return { project, byId: new Map(project.nodes.map((n) => [n.id, n])), outgoing, incoming };
}

/** A short human name for a node (REA labels can be internal, e.g. `BrowserWindow@6:14-13:4`). */
export function nodeName(n: StudioNode): string {
  switch (n.kind) {
    case 'ipc-channel':
      return n.channel ?? `dynamic channel (${n.channelExpression ?? '?'})`;
    case 'ipc-handler':
      return `${n.side} ${n.operation}(${n.channel ?? n.channelExpression ?? '?'})`;
    case 'window':
      return `BrowserWindow in ${n.sourcePath}`;
    case 'process':
      return `${n.role} process: ${n.path}`;
    case 'bridge-api':
      return `window.${n.apiKey ?? '?'}`;
    case 'storage':
      return n.name ?? `${n.storageKind} (key not resolved)`;
    case 'worker':
      return n.resolvedPath ?? n.expression ?? 'worker';
    case 'file':
      return n.path === '' ? 'artifact root' : n.path;
    case 'endpoint':
      return n.value;
    case 'external-module':
      return n.specifier;
    case 'package':
      return `${n.name}${n.version ? `@${n.version}` : ''}`;
    case 'source-map':
      return n.path ?? n.label;
    case 'analysis-gap':
      return n.path || n.label;
    case 'source-file':
    case 'module':
    case 'native-addon':
    case 'bundle-chunk':
      return n.path;
    case 'assembly':
      return `${n.name}${n.version ? ` ${n.version}` : ''} (.NET assembly)`;
    case 'managed-type':
      return n.fullName;
    case 'managed-method':
      return `${n.declaringType}.${n.name}`;
    case 'native-import':
      return `${n.library}!${n.entryPoint}`;
    case 'external-member':
      return `${n.name}(${n.parameterTypes.join(', ')})`;
    case 'native-function':
      return `${n.name} @ ${n.address}`;
    case 'android-component':
      return `${n.componentType} ${n.className}`;
    case 'android-permission':
      return n.name;
  }
}

/** Text that search matches against. */
export function searchableText(n: StudioNode): string {
  const parts: string[] = [n.kind, nodeName(n), n.label];
  if ('path' in n && typeof n.path === 'string') parts.push(n.path);
  if (n.kind === 'module') parts.push(...n.exportNames);
  if (n.kind === 'bridge-api') parts.push(...n.members);
  if (n.kind === 'endpoint' || n.kind === 'storage') parts.push(n.mechanism);
  if (n.kind === 'managed-type') parts.push(...n.fields);
  if (n.kind === 'native-import') parts.push(n.library, n.entryPoint, n.managedName ?? '');
  if (n.kind === 'android-component') parts.push(n.className, ...n.intentActions);
  return parts.join(' ').toLowerCase();
}

export function nodeRef(n: StudioNode) {
  return { id: n.id, kind: n.kind, name: nodeName(n) };
}

export function evidenceRef(e: Evidence) {
  const loc = e.location;
  return {
    state: e.state,
    confidence: e.confidence,
    at: !loc ? null : loc.kind === 'source-range' ? `${loc.file}:${loc.start.line}:${loc.start.column}` : loc.file,
    extractor: e.extractor,
    ...(e.limitations.length ? { limitations: e.limitations } : {}),
  };
}
