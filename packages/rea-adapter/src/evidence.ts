import {
  CONFIDENCE_LEVELS,
  EVIDENCE_STATES,
  type AnalysisFailure,
  type Confidence,
  type Evidence,
  type EvidenceLocation,
  type EvidenceState,
} from '@rea-studio/schema';
import type { ReaEvidence, ReaLocation, ReaProps } from './rea-types.js';
import { bool, str } from './read.js';

const isConfidence = (v: unknown): v is Confidence => (CONFIDENCE_LEVELS as readonly unknown[]).includes(v);
const isState = (v: unknown): v is EvidenceState => (EVIDENCE_STATES as readonly unknown[]).includes(v);

function toPosition(p: { line?: number; column?: number } | undefined): { line: number; column: number } | null {
  return typeof p?.line === 'number' && typeof p.column === 'number' ? { line: p.line, column: p.column } : null;
}

export function toLocation(loc: ReaLocation | undefined): EvidenceLocation | null {
  const v = loc?.available ? loc.value : null;
  if (!v) return null;
  if (v.kind === 'source-range' && typeof v.source === 'string') {
    const start = toPosition(v.start);
    const end = toPosition(v.end);
    if (start && end) return { kind: 'source-range', file: v.source, start, end };
    return { kind: 'artifact-path', file: v.source };
  }
  const file = v.path ?? v.source;
  return typeof file === 'string' ? { kind: 'artifact-path', file } : null;
}

/** Converts REA evidence. Unknown state/confidence values map to the weakest member. */
export function toEvidence(ev: ReaEvidence | null | undefined): Evidence {
  return {
    state: isState(ev?.state) ? ev.state : 'unavailable',
    confidence: isConfidence(ev?.confidence) ? ev.confidence : 'unknown',
    authority: ev?.authority ?? 'unknown',
    extractor: ev?.extractor?.operation ?? 'unknown',
    location: toLocation(ev?.location),
    limitations: (ev?.limitations ?? []).filter((l): l is string => typeof l === 'string'),
  };
}

/** Converts REA `analysis_failure` / `application_projection_failure`. */
export function toFailure(f: ReaProps | null): AnalysisFailure | null {
  if (!f) return null;
  return {
    code: str(f, 'code') ?? 'unknown',
    category: str(f, 'category') ?? 'unknown',
    message: str(f, 'message') ?? '',
    retryable: bool(f, 'retryable') ?? false,
  };
}
