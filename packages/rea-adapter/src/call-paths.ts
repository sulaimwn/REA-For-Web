// REA 6.5.0 traces each contextBridge member to the IPC call it makes. Each path is a chain of
// `javascript-expression` nodes in the `electron-call-path-step` namespace (exposure → function →
// terminal) sharing one `path_id`, linked by contains/maps_to/calls edges. StudioProject has no
// expression kind, so instead of drawing the steps each path becomes one REA edge from the bridge
// API to its IPC channel, e.g. `window.notesApi --invokes--> notes:save` (T061).
import type { IpcChannelNode, IpcOperation, Relation, StudioEdge, StudioNode } from '@rea-studio/schema';
import { toEvidence } from './evidence.js';
import type { ReaNode, ReaObservation } from './rea-types.js';
import { str } from './read.js';

export const isCallPathStep = (n: ReaNode) =>
  n.kind === 'javascript-expression' && n.identity?.namespace === 'electron-call-path-step';

/** The IPC call a path ends in: `electron.ipcRenderer.invoke` and friends. */
function terminalOperation(terminal: string | null): { relation: Relation; operation: IpcOperation } | null {
  if (terminal === null) return null;
  if (terminal === 'electron.ipcRenderer.invoke') return { relation: 'invokes', operation: 'invoke' };
  if (terminal === 'electron.ipcRenderer.sendSync') return { relation: 'sends', operation: 'send-sync' };
  if (terminal === 'electron.ipcRenderer.send') return { relation: 'sends', operation: 'send' };
  return null;
}

function artifact(n: ReaNode, o: ReaObservation): string | null {
  const sha = o.evidence?.artifact?.sha256;
  return typeof sha === 'string' && /^[a-f0-9]{64}$/u.test(sha)
    && n.identity?.artifact_sha256 === sha ? sha : null;
}

/** Exposure steps and bridge observations share the exact exposure source range. */
function exposureLocation(o: ReaObservation): string | null {
  const location = toEvidence(o.evidence).location;
  return location?.kind === 'source-range'
    ? JSON.stringify([location.file, location.start, location.end]) : null;
}

/**
 * One edge per traced bridge-member path whose bridge API and literal channel are both in the
 * project. Paths REA couldn't tie to a known bridge or channel are counted, not guessed.
 */
export function callPathEdges(steps: readonly ReaNode[], nodes: readonly StudioNode[], rawNodes: readonly ReaNode[]): { edges: StudioEdge[]; unlinked: number } {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const channels = new Map<string, IpcChannelNode[]>();
  for (const n of nodes) {
    if (n.kind === 'ipc-channel' && n.channel !== null) channels.set(n.channel, [...(channels.get(n.channel) ?? []), n]);
  }
  const bridges = new Map<string, Set<string>>();
  for (const n of rawNodes) {
    if (n.kind !== 'context-bridge-api') continue;
    for (const o of n.observations ?? []) {
      const sha = artifact(n, o);
      const api = str(o.properties, 'api_key');
      const location = exposureLocation(o);
      if (sha === null || api === null || location === null) continue;
      const key = JSON.stringify([sha, api, location]);
      const ids = bridges.get(key) ?? new Set<string>();
      ids.add(n.node_id);
      bridges.set(key, ids);
    }
  }
  const exposures = new Map<string, Set<string>>();
  for (const step of steps) {
    for (const o of step.observations ?? []) {
      const p = o.properties ?? {};
      const sha = artifact(step, o);
      const pathId = str(p, 'path_id');
      const location = exposureLocation(o);
      if (str(p, 'step_kind') !== 'exposure' || sha === null || pathId === null || location === null) continue;
      const key = `${sha}:${pathId}`;
      const locations = exposures.get(key) ?? new Set<string>();
      locations.add(location);
      exposures.set(key, locations);
    }
  }
  const edges = new Map<string, StudioEdge>();
  let unlinked = 0;
  for (const step of steps) {
    for (const o of step.observations ?? []) {
      const p = o.properties ?? {};
      if (str(p, 'step_kind') !== 'terminal') continue;
      const pathId = str(p, 'path_id');
      const sha = artifact(step, o);
      const pathKey = sha === null || pathId === null ? null : `${sha}:${pathId}`;
      const locations = pathKey === null ? undefined : exposures.get(pathKey);
      const entryPath = Array.isArray(p['entry_path']) && p['entry_path'].every((s): s is string => typeof s === 'string') ? p['entry_path'] : [];
      const channel = str(p, 'channel');
      const call = terminalOperation(str(p, 'terminal'));
      // API names can repeat in different preloads/worlds. Match REA's artifact
      // and exposure range, and retain uncertainty if more than one bridge fits.
      const matches = new Set<string>();
      for (const location of locations ?? []) {
        for (const id of bridges.get(JSON.stringify([sha, entryPath[0], location])) ?? []) matches.add(id);
      }
      const bridge = matches.size === 1 ? byId.get([...matches][0]!) : undefined;
      const targets = channel === null ? undefined : channels.get(channel);
      const target = targets?.length === 1 ? targets[0] : undefined;
      if (pathKey === null || entryPath.length < 2 || str(p, 'entry_kind') !== 'bridge-member'
        || !call || bridge?.kind !== 'bridge-api' || !target) {
        unlinked++;
        continue;
      }
      if (edges.has(pathKey)) continue;
      edges.set(pathKey, {
        id: `call-path:${pathKey}`,
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
