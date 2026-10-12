// REA node → StudioNode, following the mapping table in ARCHITECTURE.md.
import type {
  ExternalModuleNode,
  FileNode,
  IpcChannelNode,
  IpcOperation,
  IpcSide,
  Origin,
  StudioNode,
  WebPreference,
} from '@rea-studio/schema';
import { toEvidence, toFailure } from './evidence.js';
import type { ReaNode, ReaObservation, ReaProps } from './rea-types.js';
import { firstStr, mergedProps, num, obj, str, strings } from './read.js';

export type ConvertedNode =
  | { type: 'node'; node: StudioNode }
  /** An external module; `dedupeKey` is set when it should merge with others. */
  | { type: 'external'; node: ExternalModuleNode; dedupeKey: string | null }
  | { type: 'dropped'; reason: 'export-shape' }
  | { type: 'unrecognized'; node: StudioNode; reaKind: string };

const REA: Origin = { source: 'rea' };
const IPC_OPERATIONS: readonly string[] = ['send', 'send-sync', 'invoke', 'on', 'handle'];

const toSide = (v: string | null): IpcSide => (v === 'renderer' ? 'renderer' : 'main');
const toOperation = (v: string | null): IpcOperation =>
  v !== null && IPC_OPERATIONS.includes(v) ? (v as IpcOperation) : 'on';

function fileKindOf(v: string | null): FileNode['fileKind'] {
  return v === 'javascript' || v === 'html' || v === 'json' || v === 'package-json' ? v : 'other';
}

function webPreferences(p: ReaProps): WebPreference[] {
  const raw = p['web_preferences'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((wp): WebPreference[] => {
    const w = wp as ReaProps;
    const name = str(w, 'name');
    if (name === null) return [];
    const val = obj(w, 'value');
    const v = val?.['value'];
    return [{
      name,
      status: str(val, 'status') ?? 'unknown',
      value: typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null,
      expression: str(val, 'expression'),
    }];
  });
}

const isBare = (specifier: string) => !specifier.startsWith('.') && !specifier.startsWith('/');

function classifyModule(obs: ReaObservation[]): 'module' | 'bundled-module' | 'reference' | 'unresolved-reference' | 'export-shape' | null {
  const roles = obs.map((o) => o.properties ?? {});
  if (roles.some((p) => p['semantic_role'] === 'source-module')) return 'module';
  if (roles.some((p) => p['module_key'] != null && p['bundler'] != null)) return 'bundled-module';
  if (roles.some((p) => p['semantic_role'] === 'module-reference')) return 'reference';
  if (roles.some((p) => p['reference_kind'] != null && p['resolution'] === 'unresolved')) return 'unresolved-reference';
  if (roles.some((p) => p['semantic_role'] === 'export-binding' || p['semantic_role'] === 'export-return-shapes')) return 'export-shape';
  return null;
}

export function convertNode(n: ReaNode): ConvertedNode {
  const obs = n.observations ?? [];
  const p = mergedProps(obs);
  const evidence = obs.map((o) => toEvidence(o.evidence));
  const firstLabel = obs.find((o) => typeof o.label === 'string' && o.label !== '')?.label ?? null;
  const base = (label: string | null) => ({ id: n.node_id, label: label ?? firstLabel ?? n.kind, evidence, origin: REA });

  switch (n.kind) {
    case 'package':
      return { type: 'node', node: { ...base(null), kind: 'package', name: str(p, 'name') ?? firstLabel ?? 'package', version: str(p, 'version'), path: str(p, 'path') ?? 'package.json', main: str(p, 'main') } };

    case 'javascript-asset':
    case 'artifact': {
      const parse = str(p, 'parse_status');
      return {
        type: 'node',
        node: {
          ...base(null),
          kind: 'file',
          path: str(p, 'path') ?? '',
          fileKind: fileKindOf(str(p, 'file_kind')),
          bytes: num(p, 'bytes'),
          parseStatus: parse === 'complete' || parse === 'partial' ? parse : null,
          analysisIssue: toFailure(obj(p, 'application_projection_failure')),
        },
      };
    }

    case 'source-module': {
      const ref = obs.find((o) => o.source_map_reference)?.source_map_reference ?? null;
      const originalName = ref?.source_name ?? firstLabel ?? '';
      return {
        type: 'node',
        node: {
          ...base(null),
          kind: 'source-file',
          path: ref?.resolution?.path ?? originalName,
          originalName,
          sourceMapPath: ref?.map_path ?? '',
          contentAvailable: p['content_available'] === true,
        },
      };
    }

    case 'source-map':
      return { type: 'node', node: { ...base(null), kind: 'source-map', path: str(p, 'path') ?? str(p, 'resolved_path'), available: p['available'] !== false } };

    case 'javascript-module': {
      const cls = classifyModule(obs);
      if (cls === 'export-shape') return { type: 'dropped', reason: 'export-shape' };
      if (cls === 'module' || cls === 'bundled-module') {
        const format = str(p, 'module_format');
        const moduleKey = str(p, 'module_key');
        const bundler = str(p, 'bundler');
        return {
          type: 'node',
          node: {
            ...base(null),
            kind: 'module',
            path: str(p, 'path') ?? str(p, 'module_path') ?? str(p, 'logical_module_key') ?? firstLabel ?? '',
            format: format === 'esm' || format === 'commonjs' ? format : 'unknown',
            exportNames: strings(p, 'export_names'),
            bundler: moduleKey !== null && bundler !== null ? { name: bundler, runtime: str(p, 'runtime') ?? 'unknown', moduleKey } : null,
          },
        };
      }
      if (cls === 'reference' || cls === 'unresolved-reference') {
        const specifier = firstStr(obs, 'declared_specifier') ?? firstStr(obs, 'specifier') ?? firstLabel ?? '';
        const status = str(p, 'resolution_status');
        const node: ExternalModuleNode = {
          ...base(specifier),
          kind: 'external-module',
          specifier,
          resolution: status === 'external' || status === 'not-found' ? status : 'unresolved',
        };
        return { type: 'external', node, dedupeKey: specifier !== '' && isBare(specifier) ? `external-module:${specifier}` : null };
      }
      return unrecognized(n, base(null));
    }

    case 'javascript-chunk':
      return {
        type: 'node',
        node: {
          ...base(null),
          kind: 'bundle-chunk',
          path: str(p, 'path') ?? '',
          bundler: str(p, 'bundler') ?? 'unknown',
          runtime: str(p, 'runtime') ?? 'unknown',
          chunkKeys: strings(p, 'chunk_keys'),
          moduleCount: num(p, 'module_count') ?? 0,
        },
      };

    case 'electron-main':
    case 'electron-renderer':
    case 'electron-preload': {
      const role = n.kind === 'electron-main' ? 'main' : n.kind === 'electron-renderer' ? 'renderer' : 'preload';
      const path = str(p, 'resolved_path') ?? str(p, 'declared_path') ?? firstLabel ?? '';
      return {
        type: 'node',
        node: { ...base(null), kind: 'process', role, path, declaredPath: str(p, 'declared_path') ?? path, mechanism: str(p, 'mechanism') ?? 'unknown' },
      };
    }

    case 'browser-window':
      return { type: 'node', node: { ...base(null), kind: 'window', sourcePath: str(p, 'source_path') ?? '', webPreferences: webPreferences(p), preloadPath: str(p, 'preload_path') } };

    case 'context-bridge-api':
      return {
        type: 'node',
        node: { ...base(null), kind: 'bridge-api', apiKey: str(p, 'api_key'), world: str(p, 'world') ?? 'unknown', members: strings(p, 'members'), unknownMemberCount: num(p, 'unknown_members') ?? 0 },
      };

    case 'ipc-channel': {
      const usages: IpcChannelNode['usages'] = obs.map((o) => ({ side: toSide(str(o.properties, 'side')), operation: toOperation(str(o.properties, 'operation')) }));
      const dynamic = obs.some((o) => str(o.properties, 'resolution') === 'dynamic');
      return {
        type: 'node',
        node: {
          ...base(null),
          kind: 'ipc-channel',
          channel: firstStr(obs, 'channel'),
          channelExpression: firstStr(obs, 'channel_expression'),
          resolution: dynamic ? 'dynamic' : 'literal',
          usages,
        },
      };
    }

    case 'ipc-handler':
      return {
        type: 'node',
        node: {
          ...base(null),
          kind: 'ipc-handler',
          side: toSide(str(p, 'side')),
          operation: toOperation(str(p, 'operation')),
          channel: str(p, 'channel'),
          channelExpression: str(p, 'channel_expression'),
          handlerKind: str(p, 'handler_kind') ?? 'unknown',
        },
      };

    case 'native-addon':
      return { type: 'node', node: { ...base(null), kind: 'native-addon', path: str(p, 'path') ?? firstLabel ?? '', bytes: num(p, 'bytes') } };

    case 'endpoint':
      return {
        type: 'node',
        node: {
          ...base(null),
          kind: 'endpoint',
          endpointKind: str(p, 'endpoint_kind') === 'route' ? 'route' : 'network',
          value: str(p, 'value') ?? firstLabel ?? '',
          mechanism: str(p, 'mechanism') ?? 'unknown',
        },
      };

    case 'storage':
      return { type: 'node', node: { ...base(null), kind: 'storage', storageKind: str(p, 'storage_kind') ?? 'unknown', name: str(p, 'name'), mechanism: str(p, 'mechanism') ?? 'unknown' } };

    case 'worker':
      return { type: 'node', node: { ...base(str(p, 'expression')), kind: 'worker', expression: str(p, 'expression'), resolvedPath: str(p, 'resolved_path') } };

    case 'unknown':
      return {
        type: 'node',
        node: { ...base(null), kind: 'analysis-gap', path: str(p, 'path') ?? '', operation: str(p, 'operation') ?? 'unknown', failure: toFailure(obj(p, 'analysis_failure')) },
      };

    default:
      return unrecognized(n, base(null));
  }
}

/** Keeps REA nodes the adapter can't interpret visible as gaps instead of silently dropping them. */
function unrecognized(n: ReaNode, b: { id: string; label: string; evidence: StudioNode['evidence']; origin: Origin }): ConvertedNode {
  return {
    type: 'unrecognized',
    reaKind: n.kind,
    node: { ...b, kind: 'analysis-gap', path: '', operation: `studio-adapter:unrecognized-rea-node:${n.kind}`, failure: null },
  };
}
