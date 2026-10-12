// Typed accessors for untyped REA property bags.
import type { ReaObservation, ReaProps } from './rea-types.js';

export function str(p: ReaProps | null | undefined, key: string): string | null {
  const v = p?.[key];
  return typeof v === 'string' ? v : null;
}

export function num(p: ReaProps | null | undefined, key: string): number | null {
  const v = p?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function bool(p: ReaProps | null | undefined, key: string): boolean | null {
  const v = p?.[key];
  return typeof v === 'boolean' ? v : null;
}

export function strings(p: ReaProps | null | undefined, key: string): string[] {
  const v = p?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function obj(p: ReaProps | null | undefined, key: string): ReaProps | null {
  const v = p?.[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as ReaProps) : null;
}

/**
 * Merges the property bags of all observations; the first observation that
 * has a key wins. Used for kinds whose observations describe one thing from
 * different extractors (e.g. a file's inventory + static-analysis records).
 */
export function mergedProps(observations: ReaObservation[]): ReaProps {
  const out: ReaProps = {};
  for (const o of observations) {
    for (const [k, v] of Object.entries(o.properties ?? {})) {
      if (!(k in out) || out[k] === null) out[k] = v;
    }
  }
  return out;
}

/** First non-null string across observations for a key. */
export function firstStr(observations: ReaObservation[], key: string): string | null {
  for (const o of observations) {
    const v = str(o.properties, key);
    if (v !== null) return v;
  }
  return null;
}
