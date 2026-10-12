// Builds one FindingCoverage per category. REA reports coverage for the whole
// application graph, not per category, so every category shares that status.
// REA static analysis never proves absence: empty categories are `not-found`.
import type { CoverageStatus, FindingCategory, FindingCoverage, IpcSummary, StudioEdge, StudioNode } from '@rea-studio/schema';

const NOT_FOUND_NOTE = 'None found. REA static analysis never proves absence, so there may still be some.';

export function buildFindings(nodes: StudioNode[], edges: StudioEdge[], ipc: IpcSummary, coverage: CoverageStatus): FindingCoverage[] {
  const of = <K extends StudioNode['kind']>(kind: K) => nodes.filter((n): n is Extract<StudioNode, { kind: K }> => n.kind === kind);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const finding = (category: FindingCategory, count: number, unresolvedCount: number, notes: string[]): FindingCoverage => ({
    category,
    status: count > 0 ? 'found' : 'not-found',
    count,
    unresolvedCount,
    coverage,
    notes: count > 0 ? notes : [NOT_FOUND_NOTE, ...notes],
  });

  const sourceMaps = of('source-map');
  const missingMaps = sourceMaps.filter((m) => !m.available).length;
  const externals = of('external-module');
  const notFoundImports = externals.filter((m) => m.resolution === 'not-found').length;
  const issueFiles = of('file').filter((f) => f.analysisIssue !== null).length;
  const processes = of('process');
  const bridges = of('bridge-api');
  const workers = of('worker');

  return [
    finding('source-files', of('source-file').length, missingMaps,
      missingMaps > 0 ? [`${plural(missingMaps, 'source map')} referenced but not shipped`] : []),
    finding('imports', edges.filter((e) => e.relation === 'imports').length, notFoundImports, [
      ...(notFoundImports > 0 ? [`${plural(notFoundImports, 'imported module')} not found in the app`] : []),
      ...(issueFiles > 0 ? [`${plural(issueFiles, 'file')} lost relationship details to REA resource limits`] : []),
    ]),
    finding('processes', processes.length, 0,
      (['main', 'preload', 'renderer'] as const)
        .map((role) => [role, processes.filter((p) => p.role === role).length] as const)
        .filter(([, n]) => n > 0)
        .map(([role, n]) => `${n} ${role}`)),
    finding('windows', of('window').length, 0, []),
    finding('ipc', of('ipc-channel').length, ipc.dynamicChannelOperations, [
      ...(ipc.dynamicChannelOperations > 0 ? [`${plural(ipc.dynamicChannelOperations, 'IPC operation')} use dynamic channel names`] : []),
      ...(ipc.rendererTransmissions > 0 ? [`${ipc.pairedRendererTransmissions} of ${plural(ipc.rendererTransmissions, 'renderer message')} paired with a main-process handler`] : []),
    ]),
    finding('bridge-apis', bridges.length, bridges.reduce((s, b) => s + b.unknownMemberCount, 0), []),
    finding('native-addons', of('native-addon').length, 0, []),
    finding('endpoints', of('endpoint').length, 0, of('endpoint').length > 0 ? ['Unfiltered REA endpoint candidates'] : []),
    finding('storage', of('storage').length, 0, []),
    finding('workers', workers.length, workers.filter((w) => w.resolvedPath === null).length, []),
  ];
}
