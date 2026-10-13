// Reads a StudioProject JSON file chosen by the user. Runs in the browser only;
// the file is never uploaded.
import { COVERAGE_STATUSES, FINDING_CATEGORIES, NODE_KINDS, STUDIO_SCHEMA_VERSION, type StudioProject } from '@rea-studio/schema';

/** Larger than any analysis we've measured (GitHub Desktop's project is 4.5 MB). */
export const MAX_PROJECT_BYTES = 512 * 1024 * 1024;

export class ProjectFileError extends Error {}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

/** Checks the shape the explorer relies on. Not a full schema validation. */
export function parseStudioProject(text: string): StudioProject {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectFileError('This file isn’t valid JSON.');
  }
  const p = raw as Partial<StudioProject> | null;
  if (!p || typeof p !== 'object') throw new ProjectFileError('This file isn’t a REA for Web project.');
  if ('normalized_result' in p || 'project_managed_application_graph' in p || 'binary_overview' in p || 'inspect_android_package' in p) {
    throw new ProjectFileError('This is raw REA output. Convert it first with `rea-studio analyze`, which writes a .studio.json file.');
  }
  if (p.schemaVersion !== STUDIO_SCHEMA_VERSION) {
    throw new ProjectFileError(`Unsupported project version ${String(p.schemaVersion)} (this site reads ${STUDIO_SCHEMA_VERSION}).`);
  }
  if (!Array.isArray(p.nodes) || !Array.isArray(p.edges) || !Array.isArray(p.findings) || !p.target || !p.analysis) {
    throw new ProjectFileError('This project file is missing required sections.');
  }
  const a = p.analysis;
  if (typeof p.id !== 'string' || !object(p.target) || typeof p.target.name !== 'string' ||
      !['electron', 'javascript', 'dotnet', 'web', 'native', 'android'].includes(p.target.appKind) || !object(a) || !object(a.coverage) ||
      !COVERAGE_STATUSES.includes(a.coverage.status) || !Array.isArray(a.coverage.limits) ||
      !object(a.engine) || typeof a.engine.package !== 'string' || typeof a.engine.version !== 'string' ||
      !strings(a.limitations) || !strings(a.omitted) || !object(a.statistics) ||
      !Number.isFinite(a.filesWithAnalysisIssues) || !object(p.ipcSummary) ||
      p.findings.some((f) => !object(f) || !FINDING_CATEGORIES.includes(f.category) ||
        !['found', 'not-found', 'confirmed-absent'].includes(f.status) || !Number.isFinite(f.count) ||
        !Number.isFinite(f.unresolvedCount) || !strings(f.notes)) ||
      p.nodes.some((n) => !object(n) || typeof n.id !== 'string' || !NODE_KINDS.includes(n.kind) ||
        typeof n.label !== 'string' || !Array.isArray(n.evidence) || !object(n.origin)) ||
      p.edges.some((e) => !object(e) || typeof e.id !== 'string' || typeof e.source !== 'string' ||
        typeof e.target !== 'string' || typeof e.relation !== 'string' || !object(e.evidence) || !object(e.origin) || !object(e.details))) {
    throw new ProjectFileError('This project file has missing or invalid details. Export it again with REA for Web.');
  }
  return p as StudioProject;
}

export async function readProjectFile(file: File): Promise<StudioProject> {
  if (file.size > MAX_PROJECT_BYTES) throw new ProjectFileError('This file is too large to open in the browser.');
  return parseStudioProject(await file.text());
}
