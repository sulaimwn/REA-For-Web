// REA 6.4.0 `analyze-javascript-application` JSON → StudioProject.
// This is the only package that reads raw REA output (see AGENTS.md).
import {
  COVERAGE_STATUSES,
  RELATIONS,
  STUDIO_SCHEMA_VERSION,
  type CoverageStatus,
  type EdgeDetails,
  type ExternalModuleNode,
  type IpcSummary,
  type Relation,
  type StudioEdge,
  type StudioNode,
  type StudioProject,
  type TargetInfo,
} from '@rea-studio/schema';
import { ReaOutputError } from './errors.js';
import { toEvidence } from './evidence.js';
import { buildFindings } from './findings.js';
import { adaptManagedBundle, isManagedBundle } from './managed.js';
import { adaptWebBundle, isWebBundle } from './web.js';
import { adaptNativeBundle, isNativeBundle } from './native.js';
import { assessEndpoints, linkBridgeMemberReads, BRIDGE_MEMBER_READ } from './heuristics.js';
import { convertNode } from './nodes.js';
import type { ReaCoverage, ReaEdge, ReaNode, ReaProps, ReaResult } from './rea-types.js';
import { num, str } from './read.js';

export const SUPPORTED_OPERATION = 'analyze_javascript_application';

export { ReaOutputError };
export { MANAGED_OPERATION, isManagedBundle } from './managed.js';
export { WEB_OPERATION, isWebBundle } from './web.js';
export { interestingNativeStrings, isNativeBundle, nativeProcedureAddresses } from './native.js';

export { recoverDroppedRelationships } from './recover.js';
export type { IsolatedRun, RecoveryReport } from './recover.js';

export interface AdapterOptions {
  /** The rea-agents version that produced the output. REA's JSON doesn't include it. */
  reaVersion: string;
  /** Opt in to REA's retained Evidence after a clean per-source timeout. */
  retainedTimeoutEvidence?: 'allow' | 'require';
  /**
   * Name to show when REA reports no root package.json, e.g. the uploaded file's
   * original name. Without it, the name falls back to REA's input path, which in the
   * sandbox is always `target.asar`.
   */
  targetName?: string;
}

/** What the adapter changed or skipped. Not part of StudioProject; for logs and tests. */
export interface AdapterReport {
  reaNodes: number;
  reaEdges: number;
  /** `javascript-module` export-binding / export-return-shapes nodes left out by design. */
  droppedExportShapeNodes: number;
  /** REA nodes merged into a shared `external-module` node. */
  mergedExternalModuleNodes: number;
  /** Edges dropped because an endpoint was a dropped node. */
  droppedEdgesToDroppedNodes: number;
  /** Edges dropped because REA used a relation this schema doesn't know. */
  droppedEdgesUnknownRelation: Record<string, number>;
  /** Edges dropped because an endpoint id wasn't in REA's node list. */
  droppedEdgesDanglingEndpoint: number;
  /** `.asar` entries folded into the file node they map to (their evidence is kept on that file). */
  foldedAsarEntries: number;
  /** Edges dropped because folding made both ends the same node. */
  droppedSelfEdges: number;
  /** REA node kinds or unsupported property shapes (kept as `analysis-gap`). */
  unrecognizedNodeKinds: Record<string, number>;
  /** Edges added by Studio heuristics, by heuristic name (origin `studio-heuristic`). */
  heuristicEdges: Record<string, number>;
  /** Studio `endpoint-shape` verdicts added to REA endpoint candidates (T012). */
  endpointVerdicts: { plausible: number; unlikely: number };
  /** .NET only: REA call edges left out, by reason (e.g. `method-spec` targets REA doesn't name). */
  skippedManagedCalls?: Record<string, number>;
}

function assertReaResult(raw: unknown): asserts raw is ReaResult {
  const r = raw as Partial<ReaResult> | null;
  if (!r || typeof r !== 'object') throw new ReaOutputError('REA output is not a JSON object');
  if (r.operation !== SUPPORTED_OPERATION) {
    throw new ReaOutputError(`Unsupported REA operation: ${String(r.operation)} (expected ${SUPPORTED_OPERATION})`);
  }
  const g = r.normalized_result?.graph;
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
    throw new ReaOutputError('REA output has no normalized_result.graph with nodes and edges');
  }
  if (typeof r.subject?.digest?.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(r.subject.digest.sha256)) {
    throw new ReaOutputError('REA output has no valid subject.digest.sha256');
  }
}

const isRelation = (v: string): v is Relation => (RELATIONS as readonly string[]).includes(v);
const toCoverageStatus = (v: string | undefined): CoverageStatus =>
  (COVERAGE_STATUSES as readonly (string | undefined)[]).includes(v) ? (v as CoverageStatus) : 'unknown';

function edgeDetails(p: ReaProps): EdgeDetails {
  const d: EdgeDetails = {};
  const has = (k: string) => k in p;
  if (has('specifier')) d.specifier = str(p, 'specifier');
  const linkKind = str(p, 'module_link_kind') ?? str(p, 'kind');
  if (linkKind !== null) d.linkKind = linkKind;
  if (has('imported_name')) d.importedName = str(p, 'imported_name');
  if (has('exported_name')) d.exportedName = str(p, 'exported_name');
  const rs = str(p, 'resolution_status');
  if (rs === 'resolved' || rs === 'external' || rs === 'not-found') d.resolutionStatus = rs;
  if (has('channel')) d.channel = str(p, 'channel');
  if (has('channel_expression')) d.channelExpression = str(p, 'channel_expression');
  const res = str(p, 'resolution');
  if (res === 'literal' || res === 'dynamic') d.channelResolution = res;
  const side = str(p, 'side');
  if (side === 'main' || side === 'renderer') d.side = side;
  const op = str(p, 'operation');
  if (op === 'send' || op === 'send-sync' || op === 'invoke' || op === 'on' || op === 'handle') d.operation = op;
  const pairing = str(p, 'pairing_basis');
  if (pairing !== null) d.pairingBasis = pairing;
  const mechanism = str(p, 'mechanism');
  if (mechanism !== null) d.mechanism = mechanism;
  return d;
}

function ipcSummary(raw: Record<string, unknown> | undefined): IpcSummary {
  const n = (k: string) => num(raw ?? null, k) ?? 0;
  return {
    operations: n('operations'),
    literalChannels: n('literal_channels'),
    dynamicChannelOperations: n('dynamic_channel_operations'),
    rendererTransmissions: n('renderer_transmissions'),
    rendererListeners: n('renderer_listeners'),
    mainHandlers: n('main_handlers'),
    pairedRendererTransmissions: n('paired_renderer_transmissions'),
    ambiguousRendererTransmissions: n('ambiguous_renderer_transmissions'),
    unpairedLiteralRendererTransmissions: n('unpaired_literal_renderer_transmissions'),
  };
}

function coverage(c: ReaCoverage | undefined): StudioProject['analysis']['coverage'] {
  return {
    status: toCoverageStatus(c?.status),
    truncated: c?.truncated === true,
    limits: (c?.limits ?? []).flatMap((l) =>
      typeof l.name === 'string' && typeof l.value === 'number' ? [{ name: l.name, value: l.value, unit: l.unit ?? '' }] : [],
    ),
  };
}

function basename(path: string | undefined): string {
  if (!path) return 'unknown';
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Converts parsed REA JSON and reports what was dropped or merged. */
export function adaptReaResult(raw: unknown, options: AdapterOptions): { project: StudioProject; report: AdapterReport } {
  const timedOut = raw && typeof raw === 'object' &&
    (raw as Record<string, unknown>).code === 'provider_timeout';
  if (options.retainedTimeoutEvidence === 'require' && !timedOut) {
    throw new ReaOutputError('REA failed without safely retained timeout Evidence');
  }
  if (options.retainedTimeoutEvidence && timedOut) {
    const details = (raw as Record<string, unknown>).details as Record<string, unknown> | undefined;
    if (!details || details.operation !== SUPPORTED_OPERATION ||
        (details.cleanup !== undefined && details.cleanup !== 'complete')) {
      throw new ReaOutputError('Timeout result has no safely retained application Evidence');
    }
    const partial = details.partial_observation;
    assertReaResult(partial);
    if (partial.normalized_result.graph.coverage?.status !== 'partial') {
      throw new ReaOutputError('Retained timeout Evidence must report partial coverage');
    }
    raw = partial;
  }
  // .NET programs: a bundle of REA's managed inspections plus their projection (T021).
  if (isManagedBundle(raw)) return adaptManagedBundle(raw, options);
  // Websites: REA's browser-captured script analysis (T021).
  if (isWebBundle(raw)) return adaptWebBundle(raw, options);
  // Native programs: REA with the Ghidra provider (T021).
  if (isNativeBundle(raw)) return adaptNativeBundle(raw, options);
  assertReaResult(raw);
  const r = raw.normalized_result;
  const report: AdapterReport = {
    reaNodes: r.graph.nodes.length,
    reaEdges: r.graph.edges.length,
    droppedExportShapeNodes: 0,
    mergedExternalModuleNodes: 0,
    droppedEdgesToDroppedNodes: 0,
    droppedEdgesUnknownRelation: {},
    droppedEdgesDanglingEndpoint: 0,
    foldedAsarEntries: 0,
    droppedSelfEdges: 0,
    unrecognizedNodeKinds: {},
    heuristicEdges: {},
    endpointVerdicts: { plausible: 0, unlikely: 0 },
  };

  // --- nodes
  const nodes: StudioNode[] = [];
  const idMap = new Map<string, string>(); // REA node_id → Studio node id
  const dropped = new Set<string>();
  const externals = new Map<string, ExternalModuleNode>(); // dedupeKey → merged node

  // .asar inputs add an `asar-entry` per archived file: root --contains--> entry --maps_to--> file.
  // Fold each entry into the file it maps to so files aren't listed twice.
  const reaKind = new Map(r.graph.nodes.map((n) => [n.node_id, n.kind]));
  const entryTarget = new Map<string, string>();
  for (const e of r.graph.edges) {
    if (e.relation === 'maps_to' && reaKind.get(e.source_node_id) === 'asar-entry' && reaKind.get(e.target_node_id) !== 'asar-entry') {
      entryTarget.set(e.source_node_id, e.target_node_id);
    }
  }
  const foldedEntries: ReaNode[] = [];

  for (const reaNode of r.graph.nodes) {
    if (entryTarget.has(reaNode.node_id)) {
      foldedEntries.push(reaNode);
      continue;
    }
    const c = convertNode(reaNode);
    if (c.type === 'dropped') {
      dropped.add(reaNode.node_id);
      report.droppedExportShapeNodes++;
      continue;
    }
    if (c.type === 'unrecognized') {
      report.unrecognizedNodeKinds[c.reaKind] = (report.unrecognizedNodeKinds[c.reaKind] ?? 0) + 1;
    }
    if (c.type === 'external' && c.dedupeKey !== null) {
      const existing = externals.get(c.dedupeKey);
      if (existing) {
        existing.evidence.push(...c.node.evidence);
        // Prefer the most specific resolution seen for this specifier.
        if (existing.resolution === 'unresolved' && c.node.resolution !== 'unresolved') existing.resolution = c.node.resolution;
        idMap.set(reaNode.node_id, existing.id);
        report.mergedExternalModuleNodes++;
        continue;
      }
      const merged: ExternalModuleNode = { ...c.node, id: c.dedupeKey, evidence: [...c.node.evidence] };
      externals.set(c.dedupeKey, merged);
      idMap.set(reaNode.node_id, merged.id);
      nodes.push(merged);
      continue;
    }
    idMap.set(reaNode.node_id, c.node.id);
    nodes.push(c.node);
  }

  const studioById = new Map(nodes.map((n) => [n.id, n]));
  for (const entry of foldedEntries) {
    const targetId = idMap.get(entryTarget.get(entry.node_id) ?? '');
    const target = targetId === undefined ? undefined : studioById.get(targetId);
    if (target) {
      target.evidence.push(...(entry.observations ?? []).map((o) => toEvidence(o.evidence)));
      idMap.set(entry.node_id, target.id);
      report.foldedAsarEntries++;
    } else {
      // The mapped file was dropped; keep the entry visible as a file of its own.
      const c = convertNode(entry);
      if (c.type === 'node') {
        idMap.set(entry.node_id, c.node.id);
        nodes.push(c.node);
      }
    }
  }

  // --- edges
  const edges: StudioEdge[] = [];
  for (const e of r.graph.edges as ReaEdge[]) {
    if (dropped.has(e.source_node_id) || dropped.has(e.target_node_id)) {
      report.droppedEdgesToDroppedNodes++;
      continue;
    }
    const source = idMap.get(e.source_node_id);
    const target = idMap.get(e.target_node_id);
    if (source === undefined || target === undefined) {
      report.droppedEdgesDanglingEndpoint++;
      continue;
    }
    // A folded asar entry's `maps_to` edge now points the file at itself.
    if (source === target && e.source_node_id !== e.target_node_id &&
        (entryTarget.has(e.source_node_id) || entryTarget.has(e.target_node_id))) {
      report.droppedSelfEdges++;
      continue;
    }
    if (!isRelation(e.relation)) {
      report.droppedEdgesUnknownRelation[e.relation] = (report.droppedEdgesUnknownRelation[e.relation] ?? 0) + 1;
      continue;
    }
    edges.push({
      id: e.edge_id,
      source,
      target,
      relation: e.relation,
      evidence: toEvidence(e.evidence),
      origin: { source: 'rea' },
      details: edgeDetails(e.properties ?? {}),
    });
  }

  // --- heuristics (add-only, labeled studio-heuristic)
  const bridgeReads = linkBridgeMemberReads(r.semantic_graph?.nodes ?? [], nodes);
  edges.push(...bridgeReads);
  report.heuristicEdges[BRIDGE_MEMBER_READ] = bridgeReads.length;
  // Verdicts on REA's endpoint candidates; the candidates themselves are kept unchanged.
  report.endpointVerdicts = assessEndpoints(nodes);

  // --- project
  const rootPackage = nodes.find((n) => n.kind === 'package' && n.path === 'package.json');
  const format = raw.subject.format;
  const target: TargetInfo = {
    name: rootPackage?.kind === 'package' ? rootPackage.name : options.targetName ?? basename(raw.subject.name),
    version: rootPackage?.kind === 'package' ? rootPackage.version : null,
    sha256: raw.subject.digest?.sha256 ?? '', // presence checked in assertReaResult
    format: format === 'asar' ? 'asar' : 'directory',
    // Any Electron process counts: an archive can hold only the renderer half (e.g. Obsidian's obsidian.asar).
    appKind: nodes.some((n) => n.kind === 'process') ? 'electron' : 'javascript',
  };

  const stats = r.statistics ?? {};
  const graphCoverage = coverage(r.graph.coverage);
  const summary = ipcSummary(r.summary?.ipc);
  const project: StudioProject = {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    id: target.sha256,
    target,
    analysis: {
      engine: { package: 'rea-agents', version: options.reaVersion, operation: raw.operation },
      reaEvidenceId: raw.evidence_id,
      coverage: graphCoverage,
      limitations: [...new Set((r.limitations ?? []).filter((l): l is string => typeof l === 'string'))],
      statistics: {
        relevantFiles: num(stats, 'relevant_files') ?? 0,
        parsedJavascriptFiles: num(stats, 'parsed_javascript_files') ?? 0,
        parseFailures: num(stats, 'parse_failures') ?? 0,
        findings: num(stats, 'findings') ?? 0,
      },
      filesWithAnalysisIssues: nodes.filter((n) => n.kind === 'file' && n.analysisIssue !== null).length,
      omitted: ['semantic-graph', 'export-shape-nodes'],
    },
    findings: buildFindings(nodes, edges, summary, graphCoverage.status),
    ipcSummary: summary,
    nodes,
    edges,
  };
  return { project, report };
}

/** Converts parsed REA JSON into a StudioProject. Throws ReaOutputError on unusable input. */
export function toStudioProject(raw: unknown, options: AdapterOptions): StudioProject {
  return adaptReaResult(raw, options).project;
}
