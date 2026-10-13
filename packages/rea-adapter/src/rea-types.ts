// The subset of REA 6.4.0 `analyze-javascript-application` JSON that the
// adapter reads. Shapes come from fixtures/samples; see fixtures/README.md.
// Everything is optional/unknown-typed because this is external input.

export type ReaProps = Record<string, unknown>;

export interface ReaLocation {
  available?: boolean;
  value?: {
    kind?: string;
    source?: string;
    path?: string;
    start?: { line?: number; column?: number };
    end?: { line?: number; column?: number };
  } | null;
}

export interface ReaEvidence {
  authority?: string;
  state?: string;
  confidence?: string;
  location?: ReaLocation;
  extractor?: { operation?: string } | null;
  limitations?: unknown[];
}

export interface ReaObservation {
  label?: string | null;
  properties?: ReaProps | null;
  evidence?: ReaEvidence | null;
  source_map_reference?: {
    source_name?: string;
    map_path?: string;
    resolution?: { kind?: string; path?: string } | null;
  } | null;
}

export interface ReaNode {
  node_id: string;
  kind: string;
  observations?: ReaObservation[];
}

export interface ReaEdge {
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  relation: string;
  properties?: ReaProps | null;
  evidence?: ReaEvidence | null;
}

export interface ReaCoverage {
  status?: string;
  truncated?: boolean;
  limits?: { name?: string; value?: number | null; unit?: string }[];
}

export interface ReaGraph {
  schema?: string;
  nodes: ReaNode[];
  edges: ReaEdge[];
  coverage?: ReaCoverage;
}

export interface ReaResult {
  evidence_id: string;
  operation: string;
  subject: {
    name?: string;
    digest?: { sha256?: string };
    format?: string;
  };
  normalized_result: {
    graph: ReaGraph;
    summary?: { ipc?: Record<string, unknown> };
    statistics?: Record<string, unknown>;
    limitations?: unknown[];
    /** Only read by heuristics; never copied into StudioProject. */
    semantic_graph?: { nodes?: ReaSemanticNode[] } | null;
  };
}

/** The subset of REA `JavaScriptSemanticRelationGraph` nodes that heuristics read. */
export interface ReaSemanticNode {
  node_id: string;
  kind: string;
  label?: string;
  /** e.g. `{ operation_kind: 'read', property_path: ['notesApi', 'save'] }`. */
  properties?: ReaProps | null;
  evidence?: { location?: ReaLocation } | null;
}
