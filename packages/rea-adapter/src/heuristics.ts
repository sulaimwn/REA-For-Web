// Studio heuristics: inferences REA doesn't make, always added with
// `origin.source = 'studio-heuristic'` and `inferred` evidence. They only add
// edges; they never change or remove REA facts.
import type { BridgeApiNode, StudioEdge, StudioNode } from '@rea-studio/schema';
import { toLocation } from './evidence.js';
import type { ReaSemanticNode } from './rea-types.js';

export const BRIDGE_MEMBER_READ = 'bridge-member-read';

/**
 * Links renderer code to the contextBridge API it uses. REA records the bridge
 * (`contextBridge.exposeInMainWorld('notesApi', { save, ... })`) and, in its
 * semantic graph, property reads like `window.notesApi.save` (path
 * `['notesApi', 'save']`), but never connects them. When a read's first two
 * path segments equal a bridge's API key and one of its members, add
 * `<file> --calls--> <bridge-api>`. Matching is by name only, so confidence is
 * `medium`.
 */
export function linkBridgeMemberReads(semanticNodes: readonly ReaSemanticNode[], nodes: readonly StudioNode[]): StudioEdge[] {
  const bridges = new Map<string, BridgeApiNode[]>();
  for (const n of nodes) {
    if (n.kind !== 'bridge-api' || n.apiKey === null) continue;
    const list = bridges.get(n.apiKey);
    if (list) list.push(n);
    else bridges.set(n.apiKey, [n]);
  }
  if (bridges.size === 0) return [];
  const fileByPath = new Map<string, string>();
  for (const n of nodes) if (n.kind === 'file' && n.path !== '') fileByPath.set(n.path, n.id);

  const edges: StudioEdge[] = [];
  for (const s of semanticNodes) {
    const path = s.properties?.['property_path'];
    if (s.properties?.['operation_kind'] !== 'read' || !Array.isArray(path) || path.length < 2) continue;
    const [key, member] = path;
    if (typeof key !== 'string' || typeof member !== 'string') continue;
    const location = toLocation(s.evidence?.location);
    const fileId = location ? fileByPath.get(location.file) : undefined;
    if (!location || !fileId) continue;
    for (const bridge of bridges.get(key) ?? []) {
      if (!bridge.members.includes(member)) continue;
      edges.push({
        id: `heuristic:${BRIDGE_MEMBER_READ}:${s.node_id}:${bridge.id}`,
        source: fileId,
        target: bridge.id,
        relation: 'calls',
        origin: {
          source: 'studio-heuristic',
          heuristic: BRIDGE_MEMBER_READ,
          basis: `Reads window.${key}.${member}; a contextBridge API exposes '${key}' with member '${member}'.`,
        },
        evidence: {
          state: 'inferred',
          confidence: 'medium',
          authority: 'studio-heuristic',
          extractor: BRIDGE_MEMBER_READ,
          location,
          limitations: ['Matched by name only; not proven to be the same object at runtime.'],
        },
        details: { mechanism: `window.${key}.${member}` },
      });
    }
  }
  return edges;
}
