// REA 6.4.0 `analyze_web_bundle` (a website's scripts, captured through a browser) → StudioProject (T021).
// Fixture: fixtures/samples/reaforweb-dev-landing.web-bundle.rea-6.4.0.json.
// The result isn't an application graph: it lists captured scripts, string routes and endpoint
// candidates with script locations, and inferences (framework and bundler fingerprints). Scripts
// become files under a root for the page; routes/endpoints hang off the script they're in; each
// fingerprint becomes an external module the scripts are inferred to use.
import {
  STUDIO_SCHEMA_VERSION,
  type Confidence,
  type Evidence,
  type ExternalModuleNode,
  type FileNode,
  type FindingCoverage,
  type StudioEdge,
  type StudioNode,
  type StudioProject,
} from '@rea-studio/schema';
import { ReaOutputError } from './errors.js';
import type { AdapterOptions, AdapterReport } from './index.js';
import { num, obj, str } from './read.js';
import type { ReaProps } from './rea-types.js';

export const WEB_OPERATION = 'analyze_web_bundle';

const list = (p: ReaProps | null | undefined, key: string): ReaProps[] => {
  const v = p?.[key];
  return Array.isArray(v) ? v.filter((x): x is ReaProps => !!x && typeof x === 'object' && !Array.isArray(x)) : [];
};
const CONFIDENCE: readonly string[] = ['exact', 'high', 'medium', 'low', 'unknown'];

export function isWebBundle(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && (raw as { operation?: unknown }).operation === WEB_OPERATION;
}

/** A script's name in the project: its path on the page's origin, or the full URL for other origins. */
function scriptPath(url: string, origin: string): string {
  try {
    const u = new URL(url);
    return u.origin === origin ? `${u.pathname.replace(/^\//u, '')}${u.search}` : url;
  } catch {
    return url;
  }
}

export function adaptWebBundle(raw: unknown, options: AdapterOptions): { project: StudioProject; report: AdapterReport } {
  const env = raw as { evidence_id?: unknown; normalized_result?: ReaProps; limitations?: unknown };
  const r = env.normalized_result;
  const targetUrl = str(obj(r, 'capture'), 'target_url');
  const id = typeof env.evidence_id === 'string' ? /^ev_([a-f0-9]{64})$/u.exec(env.evidence_id)?.[1] : undefined;
  if (!r || !targetUrl || !id) throw new ReaOutputError('Web bundle result has no capture, target URL or evidence id');
  let origin: string;
  try { origin = new URL(targetUrl).origin; } catch { throw new ReaOutputError('Web bundle target URL is not a URL'); }

  const complete = str(obj(r, 'completeness'), 'status') === 'complete';
  const observed = (file: string | null, line?: number | null, column?: number | null, extractor = WEB_OPERATION): Evidence => ({
    state: 'observed',
    // REA gives no per-item confidence for routes and endpoints.
    confidence: 'unknown',
    authority: 'browser-capture-static-analysis',
    extractor,
    location: file === null ? null : typeof line === 'number' && typeof column === 'number'
      ? { kind: 'source-range', file, start: { line, column }, end: { line, column } }
      : { kind: 'artifact-path', file },
    limitations: [],
  });

  const nodes: StudioNode[] = [];
  const edges: StudioEdge[] = [];
  const root: FileNode = {
    id: `web:${id}:page`, kind: 'file', label: targetUrl, evidence: [observed(null)], origin: { source: 'rea' },
    path: '', fileKind: 'html', bytes: null, parseStatus: null, analysisIssue: null,
  };
  nodes.push(root);

  // Scripts the page loaded. Inline <script> blocks report the page's own URL.
  const scripts = new Map<string, FileNode>(); // script_key → node
  let inline = 0;
  for (const s of list(obj(obj(r, 'observations'), 'chunks'), 'nodes')) {
    const key = str(s, 'script_key');
    const url = str(s, 'url');
    if (!key || !url || scripts.has(key)) continue;
    const path = url === targetUrl || scriptPath(url, origin) === '' ? `(inline script ${++inline})` : scriptPath(url, origin);
    const node: FileNode = {
      id: `web:${id}:${key}`, kind: 'file', label: url, evidence: [observed(path)], origin: { source: 'rea' },
      path, fileKind: 'javascript', bytes: num(s, 'bytes'), parseStatus: complete ? 'complete' : null, analysisIssue: null,
    };
    scripts.set(key, node);
    nodes.push(node);
    edges.push({ id: `${node.id}:contained`, source: root.id, target: node.id, relation: 'contains', evidence: node.evidence[0] as Evidence, origin: { source: 'rea' }, details: {} });
  }

  // Routes and endpoint candidates, each attached to its script.
  const candidates = [
    ...list(obj(r, 'observations'), 'routes').map((x) => ({ x, kind: 'route' as const })),
    ...list(obj(r, 'observations'), 'endpoints').map((x) => ({ x, kind: 'network' as const })),
  ];
  candidates.forEach(({ x, kind }, i) => {
    const loc = obj(x, 'location');
    const script = scripts.get(str(loc, 'script_key') ?? '');
    const value = str(x, 'value') ?? '';
    const mechanism = str(x, 'mechanism') ?? 'unknown';
    const evidence = observed(script?.path ?? null, num(loc, 'line'), num(loc, 'column'));
    const node: StudioNode = {
      id: `web:${id}:${kind}:${i}`, kind: 'endpoint', label: value, evidence: [evidence], origin: { source: 'rea' },
      endpointKind: kind, value, mechanism,
    };
    nodes.push(node);
    edges.push({ id: `${node.id}:called`, source: script?.id ?? root.id, target: node.id, relation: 'calls', evidence, origin: { source: 'rea' }, details: { mechanism } });
  });

  // Framework and bundler fingerprints: REA's inferences, so inferred evidence with REA's confidence.
  const frameworks = new Map<string, ExternalModuleNode>();
  for (const inf of list(r, 'inferences')) {
    const value = str(inf, 'value');
    const kind = str(inf, 'kind');
    if (!value || !kind) continue;
    const c = str(inf, 'confidence') ?? 'unknown';
    const confidence = (CONFIDENCE.includes(c) ? c : 'unknown') as Confidence;
    let fw = frameworks.get(value);
    if (!fw) {
      fw = { id: `web:${id}:fingerprint:${value}`, kind: 'external-module', label: value, evidence: [], origin: { source: 'rea' }, specifier: value, resolution: 'external' };
      frameworks.set(value, fw);
      nodes.push(fw);
    }
    for (const b of list(inf, 'basis')) {
      const script = scripts.get(str(b, 'script_key') ?? '');
      const evidence: Evidence = {
        ...observed(script?.path ?? null, num(b, 'line'), num(b, 'column'), str(b, 'detector') ?? WEB_OPERATION),
        state: 'inferred',
        confidence,
        limitations: [`${kind === 'bundle_runtime' ? 'Bundler runtime' : 'Framework'} recognized by a code fingerprint, not by an import.`],
      };
      fw.evidence.push(evidence);
      const edgeId = `${fw.id}:${script?.id ?? root.id}`;
      if (!edges.some((e) => e.id === edgeId)) {
        edges.push({ id: edgeId, source: script?.id ?? root.id, target: fw.id, relation: 'imports', evidence, origin: { source: 'rea' }, details: { linkKind: kind } });
      }
    }
  }

  const endpoints = nodes.filter((n) => n.kind === 'endpoint').length;
  const finding = (category: FindingCoverage['category'], count: number, notes: string[]): FindingCoverage => ({
    category, status: count > 0 ? 'found' : 'not-found', count, unresolvedCount: 0, coverage: complete ? 'complete' : 'partial',
    notes: count > 0 ? notes : ['None found. REA static analysis never proves absence, so there may still be some.', ...notes],
  });
  const limitations = [...new Set([...(Array.isArray(r['limitations']) ? r['limitations'] : []), ...(Array.isArray(env.limitations) ? env.limitations : [])]
    .filter((l): l is string => typeof l === 'string'))];

  const project: StudioProject = {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    // Websites have no single file digest; REA's evidence id identifies this capture.
    id,
    target: { name: options.targetName ?? new URL(targetUrl).host, version: null, sha256: id, format: 'url', appKind: 'web' },
    analysis: {
      engine: { package: 'rea-agents', version: options.reaVersion, operation: WEB_OPERATION },
      reaEvidenceId: env.evidence_id as string,
      coverage: { status: complete ? 'complete' : 'partial', truncated: false, limits: [] },
      limitations,
      statistics: { relevantFiles: scripts.size, parsedJavascriptFiles: num(obj(r, 'completeness'), 'parsed_scripts') ?? 0, parseFailures: num(obj(r, 'completeness'), 'parse_failures') ?? 0, findings: endpoints },
      filesWithAnalysisIssues: 0,
      omitted: [],
    },
    findings: [
      finding('imports', frameworks.size, frameworks.size > 0 ? [`Recognized: ${[...frameworks.keys()].join(', ')} (code fingerprints)`] : []),
      finding('endpoints', endpoints, endpoints > 0 ? ['Unfiltered REA endpoint and route candidates'] : []),
    ],
    ipcSummary: {
      operations: 0, literalChannels: 0, dynamicChannelOperations: 0, rendererTransmissions: 0, rendererListeners: 0,
      mainHandlers: 0, pairedRendererTransmissions: 0, ambiguousRendererTransmissions: 0, unpairedLiteralRendererTransmissions: 0,
    },
    nodes,
    edges,
  };
  const report: AdapterReport = {
    reaNodes: nodes.length, reaEdges: edges.length, droppedExportShapeNodes: 0, mergedExternalModuleNodes: 0, droppedEdgesToDroppedNodes: 0,
    droppedEdgesUnknownRelation: {}, droppedEdgesDanglingEndpoint: 0, foldedAsarEntries: 0, droppedSelfEdges: 0, unrecognizedNodeKinds: {}, heuristicEdges: {},
  };
  return { project, report };
}
