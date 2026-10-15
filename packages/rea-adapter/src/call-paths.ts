// REA 6.5.0 traces each contextBridge member to the IPC call it makes. Each path is a chain of
// `javascript-expression` nodes in the `electron-call-path-step` namespace (exposure → function →
// terminal) sharing one `path_id`, linked by contains/maps_to/calls edges. StudioProject has no
// expression kind, so instead of drawing the steps each path becomes one REA edge from the bridge
// API to its IPC channel, e.g. `window.notesApi --invokes--> notes:save` (T061).
import type { BridgeApiNode, IpcChannelNode, IpcOperation, Relation, StudioEdge, StudioNode } from '@rea-studio/schema';
import { toEvidence } from './evidence.js';
import type { ReaNode } from './rea-types.js';
import { str } from './read.js';

export const isCallPathStep = (n: ReaNode) =>
  n.kind === 'javascript-expression' && n.identity?.namespace === 'electron-call-path-step';

/** The IPC call a path ends in: `electron.ipcRenderer.invoke` and friends. */
function terminalOperation(terminal: string | null): { relation: Relation; operation: IpcOperation } | null {
  if (terminal === null) return null;
  if (/\.invoke$/u.test(terminal)) return { relation: 'invokes', operation: 'invoke' };
  if (/\.sendSync$/u.test(terminal)) return { relation: 'sends', operation: 'send-sync' };
  if (/\.send$/u.test(terminal)) return { relation: 'sends', operation: 'send' };
  return null;
}

/**
 * One edge per traced bridge-member path whose bridge API and literal channel are both in the
 * project. Paths REA couldn't tie to a known bridge or channel are counted, not guessed.
 */
export function callPathEdges(steps: readonly ReaNode[], nodes: readonly StudioNode[]): { edges: StudioEdge[]; unlinked: number } {
  const bridges = new Map<string, BridgeApiNode>();
  const channels = new Map<string, IpcChannelNode>();
  for (const n of nodes) {
    if (n.kind === 'bridge-api' && n.apiKey !== null && !bridges.has(n.apiKey)) bridges.set(n.apiKey, n);
    if (n.kind === 'ipc-channel' && n.channel !== null && !channels.has(n.channel)) channels.set(n.channel, n);
  }
  const edges = new Map<string, StudioEdge>();
  let unlinked = 0;
  for (const step of steps) {
    for (const o of step.observations ?? []) {
      const p = o.properties ?? {};
      if (str(p, 'step_kind') !== 'terminal') continue;
      const pathId = str(p, 'path_id');
      const entryPath = Array.isArray(p['entry_path']) ? (p['entry_path'] as unknown[]).filter((s): s is string => typeof s === 'string') : [];
      const channel = str(p, 'channel');
      const call = terminalOperation(str(p, 'terminal'));
      const bridge = entryPath[0] === undefined ? undefined : bridges.get(entryPath[0]);
      const target = channel === null ? undefined : channels.get(channel);
      if (pathId === null || str(p, 'entry_kind') !== 'bridge-member' || !call || !bridge || !target) {
        unlinked++;
        continue;
      }
      if (edges.has(pathId)) continue;
      edges.set(pathId, {
        id: `call-path:${pathId}`,
        source: bridge.id,
        target: target.id,
        relation: call.relation,
        // REA marks these paths as candidates: its evidence state (inferred) carries that.
        evidence: toEvidence(o.evidence),
        origin: { source: 'rea' },
        details: {
          channel,
          channelResolution: 'literal',
          side: 'renderer',
          operation: call.operation,
          pairingBasis: `electron-call-path ${entryPath.join('.')} (${str(p, 'resolution') ?? 'unknown'})`,
        },
      });
    }
  }
  return { edges: [...edges.values()], unlinked };
}
