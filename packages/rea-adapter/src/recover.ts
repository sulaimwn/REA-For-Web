// T008: recover relationships REA dropped in a whole-app run.
//
// In big apps, REA 6.4.0's shared result budget drops the relationships of most files
// (`application_projection_failure: resource_constraint`; 139 of 179 files in GitHub Desktop),
// keeping only the file node. Analyzed on its own (with its source map and the root
// package.json at the same relative paths), the same file comes back complete. This merges
// such per-file runs into the whole-app project: everything reachable from the file in its
// own run (imports, storage writes, IPC, bundled modules, endpoints, workers, gaps), matched
// to what the whole-app project already has so nothing is duplicated. Both sides are REA facts.
import type { IpcChannelNode, StudioEdge, StudioNode, StudioNodeKind, StudioProject } from '@rea-studio/schema';
import { buildFindings } from './findings.js';

/** One file's own REA run, adapted with this package (see adaptReaResult). */
export interface IsolatedRun {
  /** The file's path in the whole app, e.g. `main.js`; the run kept the same relative path. */
  path: string;
  project: StudioProject;
}

export interface RecoveryReport {
  /** Files whose dropped relationships came back. */
  recoveredFiles: string[];
  skipped: { path: string; reason: string }[];
  addedNodes: number;
  addedEdges: number;
  /** Isolated-run nodes matched to an existing node (same import, IPC channel, site…). */
  mergedNodes: number;
  /** Relative imports the isolated run couldn't resolve, linked to the app file they name. */
  resolvedRelativeImports: number;
}

/** The app's own structure, which the whole-app run already has right; never imported from a per-file run. */
const STRUCTURAL: ReadonlySet<StudioNodeKind> = new Set(['file', 'package', 'process', 'source-map', 'source-file']);

function siteKey(n: StudioNode): string {
  const loc = n.evidence[0]?.location;
  const at = !loc ? '' : loc.kind === 'source-range' ? `${loc.file}:${loc.start.line}:${loc.start.column}` : loc.file;
  return `${n.kind}|${n.label}|${at}`;
}

const literalChannel = (n: StudioNode): n is IpcChannelNode & { channel: string } =>
  n.kind === 'ipc-channel' && n.resolution === 'literal' && n.channel !== null;

const isRelative = (specifier: string) => /^\.{1,2}\//u.test(specifier);

/**
 * A relative import seen in a file analyzed alone can't resolve: the other file wasn't there.
 * Resolve it against the whole app's files (Node-style candidates) relative to the importing file.
 */
function resolveInApp(fromFile: string, specifier: string, files: ReadonlyMap<string, StudioNode>): StudioNode | undefined {
  const parts = fromFile.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  const p = parts.join('/');
  for (const candidate of [p, `${p}.js`, `${p}.mjs`, `${p}.cjs`, `${p}.json`, `${p}/index.js`]) {
    const file = files.get(candidate);
    if (file) return file;
  }
  return undefined;
}

/** Returns a new project; the input is not modified. Safe to apply the same run twice. */
export function recoverDroppedRelationships(base: StudioProject, runs: IsolatedRun[]): { project: StudioProject; report: RecoveryReport } {
  const project = structuredClone(base);
  const report: RecoveryReport = { recoveredFiles: [], skipped: [], addedNodes: 0, addedEdges: 0, mergedNodes: 0, resolvedRelativeImports: 0 };
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  const fileByPath = new Map<string, Extract<StudioNode, { kind: 'file' }>>();
  for (const n of project.nodes) if (n.kind === 'file') fileByPath.set(n.path, n);
  const channelByName = new Map<string, IpcChannelNode>();
  for (const n of project.nodes) if (literalChannel(n)) channelByName.set(n.channel, n);
  const bySite = new Map(project.nodes.map((n) => [siteKey(n), n]));
  const edgeKeys = new Set(project.edges.map((e) => `${e.source}|${e.target}|${e.relation}`));
  const edgeIds = new Set(project.edges.map((e) => e.id));

  for (const run of runs) {
    const baseFile = fileByPath.get(run.path);
    const isoById = new Map(run.project.nodes.map((n) => [n.id, n]));
    const isoFile = run.project.nodes.find((n) => n.kind === 'file' && n.path === run.path);
    if (!baseFile || !isoFile) {
      report.skipped.push({ path: run.path, reason: !baseFile ? 'not a file of this app' : 'the run has no node for this file' });
      continue;
    }
    const isoOut = new Map<string, StudioEdge[]>();
    for (const e of run.project.edges) isoOut.set(e.source, [...(isoOut.get(e.source) ?? []), e]);

    // Map an isolated-run node to the project, importing it if it's new.
    const mapped = new Map<string, string>([[isoFile.id, baseFile.id]]);
    const map = (n: StudioNode): string => {
      const known = mapped.get(n.id);
      if (known) return known;
      let target: StudioNode | undefined = byId.get(n.id); // e.g. `external-module:<specifier>` ids are shared
      if (!target && literalChannel(n)) target = channelByName.get(n.channel);
      if (!target) target = bySite.get(siteKey(n));
      if (target) {
        const existing = target;
        report.mergedNodes++;
        existing.evidence.push(...n.evidence.filter((ev) => !existing.evidence.some((t) => JSON.stringify(t) === JSON.stringify(ev))));
        if (existing.kind === 'ipc-channel' && n.kind === 'ipc-channel') {
          for (const u of n.usages) if (!existing.usages.some((t) => t.side === u.side && t.operation === u.operation)) existing.usages.push(u);
        }
      } else {
        target = structuredClone(n);
        project.nodes.push(target);
        byId.set(target.id, target);
        bySite.set(siteKey(target), target);
        if (literalChannel(target)) channelByName.set(target.channel, target);
        report.addedNodes++;
      }
      mapped.set(n.id, target.id);
      return target.id;
    };

    // Everything reachable from the file in its own run, short of the app's structure.
    const queue = [isoFile.id];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const e of isoOut.get(id) ?? []) {
        const target = isoById.get(e.target);
        const source = isoById.get(e.source);
        if (!target || !source || STRUCTURAL.has(target.kind)) continue;
        // Only the file's own imports: relative imports inside bundled modules are relative to their
        // original source tree, not the shipped file, and the whole-app run leaves those unresolved too.
        if (source.id === isoFile.id && target.kind === 'external-module' && isRelative(target.specifier) && target.resolution !== 'external' && !mapped.has(target.id)) {
          const local = resolveInApp(run.path, target.specifier, fileByPath);
          if (local) {
            mapped.set(target.id, local.id);
            report.resolvedRelativeImports++;
          }
        }
        const s = map(source);
        const t = map(target);
        const key = `${s}|${t}|${e.relation}`;
        if (!edgeKeys.has(key)) {
          let edgeId = e.id;
          for (let i = 2; edgeIds.has(edgeId); i++) edgeId = `${e.id}#${i}`;
          project.edges.push({ ...structuredClone(e), id: edgeId, source: s, target: t });
          edgeKeys.add(key);
          edgeIds.add(edgeId);
          report.addedEdges++;
        }
        if (!seen.has(target.id)) {
          seen.add(target.id);
          queue.push(target.id);
        }
      }
    }
    baseFile.analysisIssue = null;
    report.recoveredFiles.push(run.path);
  }

  if (report.recoveredFiles.length > 0) {
    const a = project.analysis;
    a.filesWithAnalysisIssues = project.nodes.filter((n) => n.kind === 'file' && n.analysisIssue !== null).length;
    a.limitations = [
      ...a.limitations,
      `${report.recoveredFiles.length} files lost their relationships to REA's shared whole-app result budget and were re-analyzed one at a time; their relationships come from those runs.`,
    ];
    project.findings = buildFindings(project.nodes, project.edges, project.ipcSummary, a.coverage.status);
  }
  return { project, report };
}
