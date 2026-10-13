// Studio heuristics: inferences REA doesn't make, always added with
// `origin.source = 'studio-heuristic'` and `inferred` evidence. They only add
// edges; they never change or remove REA facts.
import type { BridgeApiNode, EndpointAssessment, EndpointNode, StudioEdge, StudioNode } from '@rea-studio/schema';
import { toLocation } from './evidence.js';
import type { ReaSemanticNode } from './rea-types.js';

export const BRIDGE_MEMBER_READ = 'bridge-member-read';
export const ENDPOINT_SHAPE = 'endpoint-shape';

const URL_SCHEME = /^(https?|wss?):\/\/[^\s/]+/iu;
const METHOD_AND_PATH = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/\S*$/u;
const PATH = /^\/[A-Za-z0-9_-]/u;
/** `call:fetch`, `call:request`, `call:l.fetch`, `call:octokit.request`: functions that make requests. */
const REQUEST_CALL = /^call:(?:[\w$]+\.)*(fetch|request)$/u;
/** `call:XA.CODES.get`, `call:headers.get`, `call:n.delete`: lookups in maps, headers or env. */
const LOOKUP_CALL = /^call:(?:[\w$]+\.)+(get|set|has|delete)$/u;

/**
 * Is this REA endpoint candidate a real network endpoint? REA 6.4.0 reports any string
 * passed to a `.get(...)`-like call as a candidate, so most are map keys, header names or
 * environment variables (87 of 89 in GitHub Desktop). Agreed rule (T012, `endpoint-shape`):
 * plausible when the value is an http(s)/ws(s) URL or `METHOD /path`, or a `/path` passed to
 * a fetch/request call; otherwise unlikely. It never changes REA's node, value or evidence.
 */
export function assessEndpoint(n: Pick<EndpointNode, 'value' | 'mechanism'>): EndpointAssessment {
  const value = n.value.trim();
  const fn = REQUEST_CALL.exec(n.mechanism)?.[1];
  const verdict = (v: EndpointAssessment['verdict'], basis: string): EndpointAssessment => ({ verdict: v, heuristic: ENDPOINT_SHAPE, basis });
  const scheme = URL_SCHEME.exec(value)?.[1];
  if (scheme) return verdict('plausible', `A ${scheme.toLowerCase()}:// URL${fn ? ` passed to ${fn}` : ''}.`);
  if (METHOD_AND_PATH.test(value)) return verdict('plausible', `An HTTP method and path${fn ? ` passed to ${fn}` : ''}.`);
  if (fn && PATH.test(value)) return verdict('plausible', `A path passed to ${fn}.`);
  if (value === '') return verdict('unlikely', 'An empty string.');
  const lookup = LOOKUP_CALL.exec(n.mechanism)?.[1];
  if (lookup) return verdict('unlikely', `A key passed to .${lookup}(), like a map, header or environment lookup, not a network request.`);
  if (n.mechanism === 'property:path') return verdict('unlikely', 'A string in a `path` property, not a request URL.');
  return verdict('unlikely', 'Not a URL, an HTTP method and path, or a path passed to fetch/request.');
}

/** Adds an assessment to every endpoint candidate in place. Returns verdict counts. */
export function assessEndpoints(nodes: StudioNode[]): Record<EndpointAssessment['verdict'], number> {
  const counts = { plausible: 0, unlikely: 0 };
  for (const n of nodes) {
    if (n.kind !== 'endpoint') continue;
    n.assessment = assessEndpoint(n);
    counts[n.assessment.verdict]++;
  }
  return counts;
}

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
