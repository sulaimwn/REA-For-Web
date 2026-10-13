import type { ProjectGraph } from './graph.js';

const NODE_LINK = /\]\(node:([^)\s]+)\)/g;

/** Node ids linked from an answer, kept only if they exist in the project. */
export function citedNodeIds(answer: string, graph: ProjectGraph): string[] {
  const ids: string[] = [];
  for (const m of answer.matchAll(NODE_LINK)) {
    const id = m[1];
    if (id && graph.byId.has(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
