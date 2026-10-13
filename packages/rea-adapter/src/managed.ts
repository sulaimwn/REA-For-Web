// REA 6.4.0 managed (.NET) static analysis → StudioProject (T021).
//
// Input is a bundle keyed by REA operation name (see fixtures/samples/tiny-dotnet.rea-6.4.0.json):
//   project_managed_application_graph  required: REA's graph of assembly, types, methods, P/Invoke
//   inspect_managed_artifact           optional: references, resources, architecture, entry point
//   inspect_managed_members            optional: CIL call edges and the member refs they target
//   inspect_managed_native_boundaries  optional: not read directly; its facts are in the projection
// REA's projection keeps structure only, so calls come from inspect_managed_members.
import {
  COVERAGE_STATUSES,
  RELATIONS,
  STUDIO_SCHEMA_VERSION,
  type AssemblyNode,
  type CoverageStatus,
  type Evidence,
  type ExternalMemberNode,
  type FindingCoverage,
  type ManagedMethodNode,
  type ManagedTypeNode,
  type Relation,
  type StudioEdge,
  type StudioNode,
  type StudioProject,
} from '@rea-studio/schema';
import { ReaOutputError } from './errors.js';
import { toEvidence } from './evidence.js';
import type { AdapterOptions, AdapterReport } from './index.js';
import { bool, num, obj, str } from './read.js';
import type { ReaCoverage, ReaEdge, ReaNode, ReaProps } from './rea-types.js';

export const MANAGED_OPERATION = 'project_managed_application_graph';

interface Envelope {
  evidence_id?: string;
  operation?: string;
  subject?: { name?: string; digest?: { sha256?: string }; format?: string };
  normalized_result?: ReaProps;
}

/** True for a bundle of REA managed-analysis outputs (keyed by operation name). */
export function isManagedBundle(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && MANAGED_OPERATION in raw;
}

export const NOT_MANAGED_MESSAGE =
  'This is a native program, not .NET: REA found no .NET metadata in it. REA analyzes native code with Ghidra: ' +
  'set GHIDRA_INSTALL_DIR to an extracted Ghidra 12.1.x release (with JDK 21) and run again (see docs/targets.md).';

/**
 * Checks `rea inspect-managed-artifact` output before the other managed commands run:
 * REA must have classified the file as managed. Throws ReaOutputError with a readable reason.
 */
export function assertManagedArtifact(raw: unknown): void {
  const e = raw as (Envelope & { error?: unknown; message?: unknown; code?: unknown }) | null;
  if (!e || typeof e !== 'object') throw new ReaOutputError('REA returned no managed inspection');
  if (e.error !== undefined) {
    throw new ReaOutputError(`REA couldn’t inspect this file: ${typeof e.message === 'string' ? e.message : String(e.code ?? 'unknown error')}`);
  }
  if (e.operation !== 'inspect_managed_artifact' || !e.normalized_result) throw new ReaOutputError('REA returned no managed inspection');
  const status = str(obj(e.normalized_result, 'classification'), 'status');
  if (status === 'not-managed') throw new ReaOutputError(NOT_MANAGED_MESSAGE);
  if (status !== 'managed') throw new ReaOutputError(`REA classified this file as “${status ?? 'unknown'}”, not as a .NET program`);
}

function envelope(bundle: Record<string, unknown>, key: string, required: boolean): Envelope | null {
  const e = bundle[key] as Envelope | undefined;
  if (e === undefined && !required) return null;
  if (!e || typeof e !== 'object' || e.operation !== key || !e.normalized_result || typeof e.normalized_result !== 'object') {
    throw new ReaOutputError(`Managed analysis bundle has no valid ${key} result`);
  }
  return e;
}

const list = (p: ReaProps | null | undefined, key: string): ReaProps[] => {
  const v = p?.[key];
  return Array.isArray(v) ? v.filter((x): x is ReaProps => !!x && typeof x === 'object' && !Array.isArray(x)) : [];
};
const props = (n: ReaNode): ReaProps => n.observations?.[0]?.properties ?? {};
const evidenceOf = (n: ReaNode): Evidence[] => (n.observations ?? []).map((o) => toEvidence(o.evidence));
const isRelation = (v: string): v is Relation => (RELATIONS as readonly string[]).includes(v);
const toCoverageStatus = (v: unknown): CoverageStatus =>
  (COVERAGE_STATUSES as readonly unknown[]).includes(v) ? (v as CoverageStatus) : 'unknown';

function basename(path: string | undefined): string {
  const parts = (path ?? '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'unknown';
}

export function adaptManagedBundle(raw: unknown, options: AdapterOptions): { project: StudioProject; report: AdapterReport } {
  const bundle = raw as Record<string, unknown>;
  const projection = envelope(bundle, MANAGED_OPERATION, true) as Envelope;
  const artifactInfo = envelope(bundle, 'inspect_managed_artifact', false)?.normalized_result ?? null;
  const members = envelope(bundle, 'inspect_managed_members', false)?.normalized_result ?? null;

  const result = projection.normalized_result as ReaProps;
  const graph = obj(result, 'graph') as { nodes?: unknown; edges?: unknown; coverage?: ReaCoverage; limitations?: unknown } | null;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new ReaOutputError('Managed projection has no graph with nodes and edges');
  }
  const sha256 = projection.subject?.digest?.sha256;
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(sha256)) {
    throw new ReaOutputError('Managed projection has no valid subject.digest.sha256');
  }
  const reaNodes = graph.nodes as ReaNode[];
  const reaEdges = graph.edges as ReaEdge[];

  const report: AdapterReport = {
    reaNodes: reaNodes.length,
    reaEdges: reaEdges.length,
    droppedExportShapeNodes: 0,
    mergedExternalModuleNodes: 0,
    droppedEdgesToDroppedNodes: 0,
    droppedEdgesUnknownRelation: {},
    droppedEdgesDanglingEndpoint: 0,
    foldedAsarEntries: 0,
    droppedSelfEdges: 0,
    unrecognizedNodeKinds: {},
    heuristicEdges: {},
    skippedManagedCalls: {},
  };

  // --- facts from inspect_managed_artifact
  const entryToken = str(obj(obj(obj(artifactInfo, 'pe'), 'cli'), 'entry_point'), 'value');
  const flagNames = (obj(obj(artifactInfo, 'pe'), 'cli')?.['flag_names'] ?? null) as unknown;

  // --- nodes. One assembly node absorbs REA's artifact, assembly and module nodes (1:1 for one PE file).
  const nodes: StudioNode[] = [];
  const idMap = new Map<string, string>(); // REA node_id → Studio node id
  const dropped = new Set<string>();
  const typeByToken = new Map<string, ManagedTypeNode>();
  const methodIdByToken = new Map<string, string>();
  const methodByToken = new Map<string, ManagedMethodNode>();
  const assemblyReaNode = reaNodes.find((n) => n.kind === 'managed-assembly');
  const moduleReaNode = reaNodes.find((n) => n.kind === 'managed-module');
  const moduleName = moduleReaNode ? str(props(moduleReaNode), 'name') : null;

  let assembly: AssemblyNode | null = null;
  if (assemblyReaNode) {
    const p = props(assemblyReaNode);
    assembly = {
      id: assemblyReaNode.node_id,
      kind: 'assembly',
      label: assemblyReaNode.observations?.[0]?.label ?? str(p, 'name') ?? 'assembly',
      evidence: evidenceOf(assemblyReaNode),
      origin: { source: 'rea' },
      name: str(p, 'name') ?? 'assembly',
      version: str(p, 'version'),
      moduleName,
      mvid: moduleReaNode ? str(props(moduleReaNode), 'mvid') : null,
      architecture: str(obj(artifactInfo, 'classification'), 'managed_architecture'),
      runtimeVersion: str(obj(artifactInfo, 'metadata'), 'version'),
      ilOnly: Array.isArray(flagNames) ? flagNames.includes('il-only') : null,
      entryPoint: null,
      references: list(artifactInfo, 'references').map((r) => ({ name: str(r, 'name') ?? '?', version: str(r, 'version') })),
      resources: list(artifactInfo, 'resources').map((r) => ({
        name: str(r, 'name') ?? '?',
        bytes: num(r, 'data_length'),
        embedded: bool(r, 'embedded') ?? false,
      })),
    };
    nodes.push(assembly);
    idMap.set(assemblyReaNode.node_id, assembly.id);
  }

  const fieldsByType = new Map<string, string[]>();
  const nativeImpls: ReaNode[] = [];
  for (const n of reaNodes) {
    const p = props(n);
    switch (n.kind) {
      case 'managed-assembly':
        break; // handled above
      case 'artifact':
      case 'managed-module':
        if (assembly) {
          assembly.evidence.push(...evidenceOf(n));
          idMap.set(n.node_id, assembly.id);
        } else {
          dropped.add(n.node_id);
        }
        break;
      case 'managed-type': {
        const name = str(p, 'name') ?? n.observations?.[0]?.label ?? '?';
        const node: ManagedTypeNode = {
          id: n.node_id,
          kind: 'managed-type',
          label: n.observations?.[0]?.label ?? name,
          evidence: evidenceOf(n),
          origin: { source: 'rea' },
          fullName: str(p, 'full_name') ?? name,
          namespace: str(p, 'namespace') ?? '',
          name,
          compilerGenerated: name.startsWith('<'),
          fields: [],
        };
        nodes.push(node);
        idMap.set(n.node_id, node.id);
        const token = str(p, 'token');
        if (token) typeByToken.set(token, node);
        break;
      }
      case 'managed-field': {
        // Fields are listed on their type, not drawn: they would double the graph for little insight.
        const typeToken = str(p, 'declaring_type_token');
        const name = str(p, 'name');
        if (typeToken && name) fieldsByType.set(typeToken, [...(fieldsByType.get(typeToken) ?? []), name]);
        dropped.add(n.node_id);
        break;
      }
      case 'managed-method': {
        const token = str(p, 'token');
        const node: ManagedMethodNode = {
          id: n.node_id,
          kind: 'managed-method',
          label: n.observations?.[0]?.label ?? str(p, 'name') ?? '?',
          evidence: evidenceOf(n),
          origin: { source: 'rea' },
          declaringType: str(p, 'declaring_type') ?? '',
          name: str(p, 'name') ?? '?',
          ilSize: num(p, 'il_size'),
          pinvoke: false,
          entryPoint: token !== null && token === entryToken,
        };
        nodes.push(node);
        idMap.set(n.node_id, node.id);
        if (token) {
          methodIdByToken.set(token, node.id);
          methodByToken.set(token, node);
        }
        break;
      }
      case 'managed-native-implementation':
        nativeImpls.push(n); // folded into its method below
        break;
      case 'managed-pinvoke-import': {
        const node: StudioNode = {
          id: n.node_id,
          kind: 'native-import',
          label: `${str(p, 'import_scope_name') ?? '?'}!${str(p, 'import_name') ?? '?'}`,
          evidence: evidenceOf(n),
          origin: { source: 'rea' },
          library: str(p, 'import_scope_name') ?? '?',
          entryPoint: str(p, 'import_name') ?? '?',
          managedName: str(p, 'member_name') ?? '?',
          callingConvention: str(p, 'call_convention'),
          charSet: str(p, 'char_set'),
        };
        nodes.push(node);
        idMap.set(n.node_id, node.id);
        break;
      }
      default: {
        report.unrecognizedNodeKinds[n.kind] = (report.unrecognizedNodeKinds[n.kind] ?? 0) + 1;
        const node: StudioNode = {
          id: n.node_id,
          kind: 'analysis-gap',
          label: n.observations?.[0]?.label ?? n.kind,
          evidence: evidenceOf(n),
          origin: { source: 'rea' },
          path: '',
          operation: n.kind,
          failure: null,
        };
        nodes.push(node);
        idMap.set(n.node_id, node.id);
      }
    }
  }
  for (const [token, fields] of fieldsByType) {
    const type = typeByToken.get(token);
    if (type) type.fields = fields;
  }
  // A P/Invoke's native implementation record describes the same method token.
  for (const n of nativeImpls) {
    const p = props(n);
    const method = methodByToken.get(str(p, 'token') ?? '');
    if (method) {
      method.pinvoke = bool(p, 'pinvoke_declared') ?? method.pinvoke;
      method.evidence.push(...evidenceOf(n));
      idMap.set(n.node_id, method.id);
    } else {
      dropped.add(n.node_id);
    }
  }
  if (assembly && entryToken) {
    const entry = methodByToken.get(entryToken);
    if (entry) assembly.entryPoint = `${entry.declaringType}.${entry.name}`;
  }

  // --- REA projection edges (contains, imports)
  const edges: StudioEdge[] = [];
  for (const e of reaEdges) {
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
    if (source === target) {
      report.droppedSelfEdges++; // artifact→assembly/module and method→its own native implementation
      continue;
    }
    if (!isRelation(e.relation)) {
      report.droppedEdgesUnknownRelation[e.relation] = (report.droppedEdgesUnknownRelation[e.relation] ?? 0) + 1;
      continue;
    }
    edges.push({ id: e.edge_id, source, target, relation: e.relation, evidence: toEvidence(e.evidence), origin: { source: 'rea' }, details: {} });
  }

  // --- CIL call edges from inspect_managed_members (REA facts the projection doesn't carry)
  const memberRefs = new Map(list(members, 'member_refs').map((m) => [str(m, 'token') ?? '', m]));
  const externals = new Map<string, ExternalMemberNode>();
  const calls = new Map<string, StudioEdge>();
  for (const c of list(members, 'call_edges')) {
    const callerToken = str(c, 'caller_token') ?? '';
    const source = methodIdByToken.get(callerToken);
    const targetKind = str(c, 'target_kind') ?? 'unknown';
    const targetToken = str(c, 'target_token') ?? '';
    const skip = (reason: string) => {
      const s = (report.skippedManagedCalls ??= {});
      s[reason] = (s[reason] ?? 0) + 1;
    };
    if (source === undefined) {
      skip('caller-not-in-graph');
      continue;
    }
    // Calls share the evidence record of the members inspection that observed them.
    const evidence = methodByToken.get(callerToken)?.evidence[0];
    let target: string | undefined;
    if (targetKind === 'method-def') {
      target = methodIdByToken.get(targetToken);
    } else if (targetKind === 'member-ref') {
      const ref = memberRefs.get(targetToken);
      const name = str(c, 'target_name') ?? (ref ? str(ref, 'name') : null);
      if (ref && name) {
        const id = `managed-member-ref:${sha256}:${targetToken}`;
        if (!externals.has(id)) {
          const sig = obj(ref, 'signature');
          const parameterTypes = Array.isArray(sig?.['parameter_types']) ? (sig['parameter_types'] as unknown[]).filter((t): t is string => typeof t === 'string') : [];
          const node: ExternalMemberNode = {
            id,
            kind: 'external-member',
            label: `${name}(${parameterTypes.join(', ')})`,
            evidence: evidence ? [evidence] : [],
            origin: { source: 'rea' },
            name,
            parameterTypes,
            returnType: str(sig, 'return_type'),
          };
          externals.set(id, node);
          nodes.push(node);
        }
        target = id;
      }
    }
    if (target === undefined) {
      skip(targetKind); // e.g. method-spec: a generic instantiation REA doesn't name
      continue;
    }
    const key = `${source}|${target}`;
    const existing = calls.get(key);
    if (existing) {
      existing.details.callSites = (existing.details.callSites ?? 1) + 1;
      continue;
    }
    const edge: StudioEdge = {
      id: `managed-call:${sha256}:${callerToken}:${targetToken}`,
      source,
      target,
      relation: 'calls',
      evidence: evidence ?? toEvidence(null),
      origin: { source: 'rea' },
      details: { mechanism: str(c, 'opcode') ?? 'call', callSites: 1 },
    };
    calls.set(key, edge);
    edges.push(edge);
  }

  // --- project
  const graphCoverage: StudioProject['analysis']['coverage'] = {
    status: toCoverageStatus(graph.coverage?.status ?? obj(result, 'coverage')?.['status']),
    truncated: graph.coverage?.truncated === true,
    limits: [],
  };
  const limitations = [...new Set(
    [...(Array.isArray(graph.limitations) ? graph.limitations : []), ...(Array.isArray(result['limitations']) ? result['limitations'] : [])]
      .filter((l): l is string => typeof l === 'string'),
  )];
  if (!members) limitations.push('No managed member inspection was supplied, so calls between methods are not shown.');
  const summary = obj(result, 'summary');

  const project: StudioProject = {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    id: sha256,
    target: {
      name: assembly?.name ?? options.targetName ?? basename(projection.subject?.name),
      version: assembly?.version ?? null,
      sha256,
      format: 'pe',
      appKind: 'dotnet',
    },
    analysis: {
      engine: { package: 'rea-agents', version: options.reaVersion, operation: MANAGED_OPERATION },
      reaEvidenceId: projection.evidence_id ?? '',
      coverage: graphCoverage,
      limitations,
      statistics: { relevantFiles: 1, parsedJavascriptFiles: 0, parseFailures: 0, findings: num(summary, 'graph_nodes') ?? reaNodes.length },
      filesWithAnalysisIssues: 0,
      omitted: ['managed-fields'],
    },
    findings: managedFindings(nodes, graphCoverage.status),
    ipcSummary: {
      operations: 0, literalChannels: 0, dynamicChannelOperations: 0, rendererTransmissions: 0, rendererListeners: 0,
      mainHandlers: 0, pairedRendererTransmissions: 0, ambiguousRendererTransmissions: 0, unpairedLiteralRendererTransmissions: 0,
    },
    nodes,
    edges,
  };
  return { project, report };
}

function managedFindings(nodes: StudioNode[], coverage: CoverageStatus): FindingCoverage[] {
  const of = <K extends StudioNode['kind']>(kind: K) => nodes.filter((n): n is Extract<StudioNode, { kind: K }> => n.kind === kind);
  const finding = (category: FindingCoverage['category'], count: number, notes: string[]): FindingCoverage => ({
    category,
    status: count > 0 ? 'found' : 'not-found',
    count,
    unresolvedCount: 0,
    coverage,
    notes: count > 0 ? notes : ['None found. REA static analysis never proves absence, so there may still be some.', ...notes],
  });
  const types = of('managed-type');
  const generated = types.filter((t) => t.compilerGenerated).length;
  const methods = of('managed-method');
  const pinvokes = methods.filter((m) => m.pinvoke).length;
  const imports = of('native-import');
  const libraries = [...new Set(imports.map((i) => i.library))];
  return [
    finding('types', types.length, generated > 0 ? [`${generated} generated by the compiler (e.g. async state machines)`] : []),
    finding('methods', methods.length, pinvokes > 0 ? [`${pinvokes} declared as calls into native code (P/Invoke)`] : []),
    finding('native-imports', imports.length, [
      ...(libraries.length > 0 ? [`Libraries: ${libraries.join(', ')}`] : []),
      'REA proves the declarations only, not that each native library or export exists.',
    ]),
    finding('external-apis', of('external-member').length, ['Methods outside the app that its code calls. REA 6.4.0 names the member but not its declaring type.']),
  ];
}
