// REA 6.4.0 native-program analysis (Ghidra provider) → StudioProject (T021).
//
// Input is a bundle keyed by REA MCP tool name, collected in one Ghidra session
// (see native-session.ts and fixtures/samples/tiny-native.rea-6.4.0.json):
//   binary_overview, list_procedures, list_strings              one envelope each
//   procedure_callees  { <procedure address>: envelope }          direct callees per function
//   xrefs              { <string address>: envelope }             references to selected strings
//   containing         { <reference address>: envelope }          resolve_containing_procedure per reference
// Functions become `native-function` nodes, imported DLL functions `native-import`, calls `calls`
// edges (import thunks folded into their import), and URL / registry / file strings become endpoint
// and storage nodes linked from the functions that reference them.
import {
  STUDIO_SCHEMA_VERSION,
  type CoverageStatus,
  type Evidence,
  type FindingCoverage,
  type NativeFunctionNode,
  type NativeImportNode,
  type StudioEdge,
  type StudioNode,
  type StudioProject,
} from '@rea-studio/schema';
import { ReaOutputError } from './errors.js';
import { assessEndpoints } from './heuristics.js';
import type { AdapterOptions, AdapterReport } from './index.js';
import type { ReaProps } from './rea-types.js';

interface Envelope {
  evidence_id?: string;
  operation?: string;
  subject?: { name?: string; digest?: { sha256?: string }; format?: string; architecture?: string | null };
  normalized_result?: unknown;
  confidence?: string;
  authority?: string;
  limitations?: unknown;
}

/** True for a bundle of REA native-analysis tool results. */
export function isNativeBundle(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && 'binary_overview' in raw && 'list_procedures' in raw;
}

const URL_STRING = /^(https?|wss?):\/\/\S+$/u;
const REGISTRY_STRING = /^(Software|SOFTWARE|HKEY_[A-Z_]+|System|SYSTEM)\\\S/u;
const FILE_STRING = /^[\w .-]+\.(txt|json|db|sqlite|ini|log|cfg|xml|dat)$/iu;

/** Which strings the collector should find references for: URLs, registry paths and data-file names. */
export function interestingNativeStrings(listStrings: unknown): string[] {
  const items = (listStrings as Envelope | null)?.normalized_result;
  if (!Array.isArray(items)) return [];
  return items
    .filter((s): s is { address: string; value: string } => !!s && typeof s.address === 'string' && typeof s.value === 'string')
    .filter((s) => URL_STRING.test(s.value) || REGISTRY_STRING.test(s.value) || FILE_STRING.test(s.value))
    .map((s) => s.address);
}

/** Addresses of the program's own functions, whose callees the collector should list. */
export function nativeProcedureAddresses(listProcedures: unknown): string[] {
  const items = (listProcedures as Envelope | null)?.normalized_result;
  if (!Array.isArray(items)) return [];
  return items
    .filter((p): p is { address: string; procedure?: { external?: boolean } } => !!p && typeof p.address === 'string')
    .filter((p) => p.procedure?.external !== true)
    .map((p) => p.address);
}

const limitationsOf = (env: Envelope | undefined): string[] => Array.isArray(env?.limitations)
  ? env.limitations.filter((l): l is string => typeof l === 'string') : [];

export function adaptNativeBundle(raw: unknown, options: AdapterOptions): { project: StudioProject; report: AdapterReport } {
  const b = raw as Record<string, unknown>;
  const overview = b['binary_overview'] as Envelope | undefined;
  const procedures = (b['list_procedures'] as Envelope | undefined)?.normalized_result;
  const strings = (b['list_strings'] as Envelope | undefined)?.normalized_result;
  const sha256 = overview?.subject?.digest?.sha256;
  if (!overview || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(sha256) || !Array.isArray(procedures)) {
    throw new ReaOutputError('Native analysis bundle has no binary overview with a digest, or no procedure list');
  }
  const callees = (b['procedure_callees'] ?? {}) as Record<string, Envelope>;
  const xrefs = (b['xrefs'] ?? {}) as Record<string, Envelope>;
  const containing = (b['containing'] ?? {}) as Record<string, Envelope>;

  const program = options.targetName ?? (overview.subject?.name ?? 'program').split(/[\\/]/u).pop() ?? 'program';
  const evidenceFrom = (env: Envelope | undefined, extractor: string): Evidence => ({
    state: env?.confidence === 'observed' ? 'observed' : 'inferred',
    // REA reports Ghidra's results as observed analysis of the shipped bytes, without a confidence grade.
    confidence: 'unknown',
    authority: env?.authority ?? 'shipped-artifact',
    extractor,
    location: { kind: 'artifact-path', file: program },
    limitations: limitationsOf(env),
  });
  const procEvidence = evidenceFrom(b['list_procedures'] as Envelope, 'list_procedures');

  const nodes: StudioNode[] = [];
  const edges: StudioEdge[] = [];
  const root: StudioNode = {
    id: `native:${sha256}`, kind: 'file', label: program, evidence: [evidenceFrom(overview, 'binary_overview')], origin: { source: 'rea' },
    path: '', fileKind: 'other', bytes: null, parseStatus: 'complete', analysisIssue: null,
  };
  nodes.push(root);

  // Functions and imports. A thunk stands for its target, so calls to it point at the target.
  const nodeIdByAddress = new Map<string, string>();
  const thunkTarget = new Map<string, string>();
  for (const p of procedures as ReaProps[]) {
    const address = typeof p['address'] === 'string' ? p['address'] : null;
    const value = typeof p['value'] === 'string' ? p['value'] : null;
    const meta = (p['procedure'] ?? {}) as { external?: boolean; thunk?: boolean; thunk_target?: string | null };
    if (!address || !value) continue;
    if (meta.external) {
      const sep = value.indexOf('::');
      const node: NativeImportNode = {
        id: `native:${sha256}:import:${address}`, kind: 'native-import', label: value, evidence: [procEvidence], origin: { source: 'rea' },
        library: sep === -1 ? '?' : value.slice(0, sep), entryPoint: sep === -1 ? value : value.slice(sep + 2), managedName: null, callingConvention: null, charSet: null,
      };
      nodes.push(node);
      nodeIdByAddress.set(address, node.id);
    } else if (meta.thunk && typeof meta.thunk_target === 'string') {
      thunkTarget.set(address, meta.thunk_target);
    } else {
      const node: NativeFunctionNode = {
        id: `native:${sha256}:fn:${address}`, kind: 'native-function', label: value, evidence: [procEvidence], origin: { source: 'rea' },
        address, name: value, entryPoint: value === 'entry' || /^(w?WinMainCRTStartup|w?mainCRTStartup)$/u.test(value),
      };
      nodes.push(node);
      nodeIdByAddress.set(address, node.id);
      edges.push({ id: `${node.id}:contained`, source: root.id, target: node.id, relation: 'contains', evidence: procEvidence, origin: { source: 'rea' }, details: {} });
    }
  }
  const resolve = (address: string): string | undefined => {
    let a = address;
    for (let hops = 0; hops < 8 && thunkTarget.has(a); hops++) a = thunkTarget.get(a) as string;
    return nodeIdByAddress.get(a);
  };

  const report: AdapterReport = {
    reaNodes: procedures.length, reaEdges: 0, droppedExportShapeNodes: 0, mergedExternalModuleNodes: 0, droppedEdgesToDroppedNodes: 0,
    droppedEdgesUnknownRelation: {}, droppedEdgesDanglingEndpoint: 0, foldedAsarEntries: 0, droppedSelfEdges: 0, unrecognizedNodeKinds: {}, heuristicEdges: {},
    endpointVerdicts: { plausible: 0, unlikely: 0 },
  };

  // Direct calls from each function (Ghidra's resolved callees; indirect calls may be missing).
  for (const [address, env] of Object.entries(callees)) {
    const source = resolve(address);
    const targets = env?.normalized_result;
    if (!source || !Array.isArray(targets)) continue;
    const evidence = evidenceFrom(env, 'procedure_callees');
    for (const t of targets) {
      if (typeof t !== 'string') continue;
      const target = resolve(t);
      if (!target) {
        report.droppedEdgesDanglingEndpoint++;
        continue;
      }
      const id = `${source}->${target}`;
      if (target === source || edges.some((e) => e.id === id)) continue;
      edges.push({ id, source, target, relation: 'calls', evidence, origin: { source: 'rea' }, details: {} });
      report.reaEdges++;
    }
  }

  // URLs, registry keys and data files, attached to the functions that reference them.
  const stringByAddress = new Map<string, string>();
  if (Array.isArray(strings)) for (const s of strings as ReaProps[]) if (typeof s['address'] === 'string' && typeof s['value'] === 'string') stringByAddress.set(s['address'], s['value']);
  for (const [address, env] of Object.entries(xrefs)) {
    const value = stringByAddress.get(address);
    if (!value) continue;
    const literalEvidence = evidenceFrom(b['list_strings'] as Envelope, 'list_strings');
    const evidence = evidenceFrom(env, 'xrefs');
    const isUrl = URL_STRING.test(value);
    const isRegistry = REGISTRY_STRING.test(value);
    const rule = 'native-string-classification';
    const origin = { source: 'studio-heuristic' as const, heuristic: rule, basis: `Classify the observed string ${JSON.stringify(value)} by its spelling.` };
    const classification: Evidence = { ...literalEvidence, state: 'inferred', authority: 'studio-heuristic', extractor: rule,
      limitations: [...literalEvidence.limitations, 'A URL, registry path or file-name string does not prove network or storage use.'] };
    const node: StudioNode = isUrl
      ? { id: `native:${sha256}:string:${address}`, kind: 'endpoint', label: value, evidence: [literalEvidence, classification], origin, endpointKind: 'network', value, mechanism: 'string-literal' }
      : { id: `native:${sha256}:string:${address}`, kind: 'storage', label: value, evidence: [literalEvidence, classification], origin, storageKind: isRegistry ? 'registry' : 'file', name: value, mechanism: 'string-literal' };
    nodes.push(node);
    const users = new Set<string>();
    const refs = env?.normalized_result;
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        const result = containing[String(ref)]?.normalized_result as { address?: unknown; procedure?: { address?: unknown } } | null | undefined;
        const fnAddress = typeof result?.address === 'string' ? result.address : typeof result?.procedure?.address === 'string' ? result.procedure.address : null;
        const fn = fnAddress ? resolve(fnAddress) : undefined;
        if (fn) users.add(fn);
      }
    }
    for (const fn of users) {
      edges.push({ id: `${fn}->${node.id}`, source: fn, target: node.id, relation: isUrl ? 'calls' : 'persists_to',
        evidence: { ...evidence, state: 'inferred', authority: 'studio-heuristic', extractor: 'native-string-reference', limitations: [...evidence.limitations, 'The function references this string; how it uses it is not analyzed.'] },
        origin: { source: 'studio-heuristic', heuristic: 'native-string-reference', basis: 'REA resolves a string reference to this function; Studio infers a possible use from the string spelling.' }, details: { mechanism: 'string reference' } });
      report.heuristicEdges['native-string-reference'] = (report.heuristicEdges['native-string-reference'] ?? 0) + 1;
    }
    if (users.size === 0) edges.push({ id: `${root.id}->${node.id}`, source: root.id, target: node.id, relation: 'contains', evidence, origin: { source: 'rea' }, details: {} });
  }

  report.endpointVerdicts = assessEndpoints(nodes);
  const of = <K extends StudioNode['kind']>(kind: K) => nodes.filter((n): n is Extract<StudioNode, { kind: K }> => n.kind === kind);
  const libraries = [...new Set(of('native-import').map((i) => i.library))];
  const named = of('native-function').filter((f) => !/^FUN_/u.test(f.name)).length;
  const missingCalls = nativeProcedureAddresses(b['list_procedures']).filter((a) => !Array.isArray(callees[a]?.normalized_result)).length;
  const selectedStrings = interestingNativeStrings(b['list_strings']);
  const missingRefs = selectedStrings.filter((a) => !Array.isArray(xrefs[a]?.normalized_result)).length;
  const missingContaining = Object.values(xrefs).flatMap((e) => Array.isArray(e?.normalized_result) ? e.normalized_result : [])
    .filter((ref) => !containing[String(ref)]?.normalized_result).length;
  const incomplete = !Array.isArray(strings) || missingCalls > 0 || missingRefs > 0 || missingContaining > 0 || report.droppedEdgesDanglingEndpoint > 0;
  const coverage: CoverageStatus = incomplete ? 'partial' : 'complete';
  const finding = (category: FindingCoverage['category'], count: number, notes: string[]): FindingCoverage => ({
    category, status: count > 0 ? 'found' : 'not-found', count, unresolvedCount: 0, coverage,
    notes: count > 0 ? notes : ['None found. REA static analysis never proves absence, so there may still be some.', ...notes],
  });
  const limitations = [...new Set([overview, b['list_procedures'] as Envelope, b['list_strings'] as Envelope,
    ...Object.values(callees), ...Object.values(xrefs), ...Object.values(containing)].flatMap(limitationsOf))];
  limitations.push('Calls are Ghidra’s resolved direct callees; indirect calls (through pointers or tables) may be missing.');
  limitations.push('Coverage describes the collected function and defined-string inventory, not every possible behavior in the program.');
  limitations.push('Entry-point flags use a Studio symbol-name pattern; they do not prove the executable header’s entry address.');
  limitations.push('Endpoint/storage classification and possible uses of string references are Studio heuristics, not REA-reported network or storage operations.');
  if (incomplete) limitations.push(`Incomplete collection: ${missingCalls} callee queries, ${missingRefs} string-reference queries and ${missingContaining} reference-resolution queries missing; ${report.droppedEdgesDanglingEndpoint} calls unresolved.${Array.isArray(strings) ? '' : ' String inventory missing.'}`);

  const project: StudioProject = {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    id: sha256,
    target: { name: program, version: null, sha256, format: 'pe', appKind: 'native' },
    analysis: {
      engine: { package: 'rea-agents', version: options.reaVersion, operation: 'binary_overview' },
      reaEvidenceId: overview.evidence_id ?? '',
      coverage: { status: coverage, truncated: false, limits: [] },
      limitations,
      statistics: { relevantFiles: 1, parsedJavascriptFiles: 0, parseFailures: 0, findings: nodes.length },
      filesWithAnalysisIssues: 0,
      omitted: [],
    },
    findings: [
      finding('functions', of('native-function').length, [`${named} named by symbols; the rest are Ghidra's FUN_<address> names`]),
      finding('native-imports', of('native-import').length, libraries.length > 0 ? [`Libraries: ${libraries.join(', ')}`] : []),
      finding('endpoints', of('endpoint').length, of('endpoint').length > 0 ? ['URLs found as strings in the program'] : []),
      finding('storage', of('storage').length, of('storage').length > 0 ? ['Registry paths and data-file names found as strings'] : []),
    ],
    ipcSummary: {
      operations: 0, literalChannels: 0, dynamicChannelOperations: 0, rendererTransmissions: 0, rendererListeners: 0,
      mainHandlers: 0, pairedRendererTransmissions: 0, ambiguousRendererTransmissions: 0, unpairedLiteralRendererTransmissions: 0,
    },
    nodes,
    edges,
  };
  return { project, report };
}
