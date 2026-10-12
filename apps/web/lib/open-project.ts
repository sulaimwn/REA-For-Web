// Reads a StudioProject JSON file chosen by the user. Runs in the browser only;
// the file is never uploaded.
import { STUDIO_SCHEMA_VERSION, type StudioProject } from '@rea-studio/schema';

/** Larger than any analysis we've measured (GitHub Desktop's project is 4.5 MB). */
export const MAX_PROJECT_BYTES = 512 * 1024 * 1024;

export class ProjectFileError extends Error {}

/** Checks the shape the explorer relies on. Not a full schema validation. */
export function parseStudioProject(text: string): StudioProject {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectFileError('This file isn’t valid JSON.');
  }
  const p = raw as Partial<StudioProject> | null;
  if (!p || typeof p !== 'object') throw new ProjectFileError('This file isn’t a REA Studio project.');
  if ('normalized_result' in p) {
    throw new ProjectFileError('This is raw REA output. Convert it first with `rea-studio analyze`, which writes a .studio.json file.');
  }
  if (p.schemaVersion !== STUDIO_SCHEMA_VERSION) {
    throw new ProjectFileError(`Unsupported project version ${String(p.schemaVersion)} (this site reads ${STUDIO_SCHEMA_VERSION}).`);
  }
  if (!Array.isArray(p.nodes) || !Array.isArray(p.edges) || !Array.isArray(p.findings) || !p.target || !p.analysis) {
    throw new ProjectFileError('This project file is missing required sections.');
  }
  return p as StudioProject;
}

export async function readProjectFile(file: File): Promise<StudioProject> {
  if (file.size > MAX_PROJECT_BYTES) throw new ProjectFileError('This file is too large to open in the browser.');
  return parseStudioProject(await file.text());
}
