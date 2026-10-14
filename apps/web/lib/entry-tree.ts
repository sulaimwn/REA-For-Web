// Big programs (thousands of functions or methods) can't be drawn whole. Their overview follows the
// links out of the program's entry points instead, so what's drawn is connected and starts where the
// program starts. A drawing choice only: nothing here is a finding.
import type { StudioEdge, StudioNode } from '@rea-studio/schema';

/** C `main` spellings; a program's own main is a better start than its runtime's entry stub. */
const MAIN_SYMBOL = /^_?w?main$/u;
/** Ghidra's placeholder names for unnamed code (stripped release builds), which tell a reader nothing. */
const GENERIC_NAME = /^(thunk_)?(FUN|SUB|LAB)_[0-9a-f]+$/iu;

const isGeneric = (n: StudioNode | undefined) => n?.kind === 'native-function' && GENERIC_NAME.test(n.name);

/** Where a program starts: a native entry or main symbol, a .NET entry method, an Android launcher. */
export function isEntryNode(n: StudioNode): boolean {
  return (n.kind === 'native-function' && (n.entryPoint || MAIN_SYMBOL.test(n.name)))
    || (n.kind === 'managed-method' && n.entryPoint)
    || (n.kind === 'android-component' && n.launcher);
}

export interface EntryTree {
  ids: Set<string>;
  roots: string[];
}

/**
 * Breadth-first along outgoing links (not containment) from the entry points, within `candidates`,
 * until `limit` nodes. At each step, named parts come first: in a stripped program the library calls
 * are what explain a function, and Ghidra's `FUN_<address>` names explain nothing. Among those, callees
 * that link onward come before leaves, so the tree reaches past its first level.
 * Null when there's no entry point or nothing it links to.
 */
export function entryTree(
  nodes: readonly StudioNode[],
  outgoing: ReadonlyMap<string, readonly StudioEdge[]>,
  candidates: ReadonlySet<string>,
  limit: number,
): EntryTree | null {
  const roots = nodes.filter((n) => candidates.has(n.id) && isEntryNode(n)).map((n) => n.id).slice(0, limit);
  if (roots.length === 0) return null;
  const ids = new Set(roots);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const linksOnward = (id: string) => (outgoing.get(id) ?? []).some((e) => e.relation !== 'contains' && e.target !== id);
  const rank = (id: string) => (isGeneric(byId.get(id)) ? 2 : 0) + (linksOnward(id) ? 0 : 1);
  const queue = [...roots];
  for (let head = 0; head < queue.length && ids.size < limit; head++) {
    const next = (outgoing.get(queue[head]!) ?? [])
      .filter((e) => e.relation !== 'contains' && candidates.has(e.target) && !ids.has(e.target))
      .map((e) => e.target);
    next.sort((a, b) => rank(a) - rank(b));
    for (const id of next) {
      if (ids.size >= limit) break;
      if (ids.has(id)) continue;
      ids.add(id);
      queue.push(id);
    }
  }
  return ids.size > roots.length ? { ids, roots } : null;
}
