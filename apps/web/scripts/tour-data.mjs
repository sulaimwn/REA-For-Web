import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

// The project id identifies the app bytes, not an adapter's graph or coverage.
export const projectFingerprint = (project) => createHash('sha256').update(JSON.stringify(project)).digest('hex');

export function publishTourFile(slug, project, source, destination, warn = console.warn) {
  // Remove a previously generated public copy even when the committed source
  // disappeared or is now stale; it must not survive the next deployment.
  rmSync(destination, { force: true });
  let doc;
  try { doc = JSON.parse(readFileSync(source, 'utf8')); }
  catch { return 0; }
  const ids = new Set(project.nodes.map((node) => node.id));
  if (!doc || doc.projectId !== project.id || doc.projectFingerprint !== projectFingerprint(project) ||
      doc.schemaVersion !== project.schemaVersion || !Array.isArray(doc.tours) ||
      doc.tours.some((tour) => !tour || typeof tour.question !== 'string' || typeof tour.answer !== 'string' ||
        typeof tour.model !== 'string' || !Array.isArray(tour.steps) || tour.steps.some((step) => !step || typeof step.name !== 'string') ||
        !Array.isArray(tour.citedNodeIds) || tour.citedNodeIds.some((id) => !ids.has(id)))) {
    warn(`tours/${slug}.json is stale or invalid; regenerate with \`npm run tours -w @rea-studio/web -- ${slug}\``);
    return 0;
  }
  writeFileSync(destination, JSON.stringify(doc));
  return doc.tours.length;
}
