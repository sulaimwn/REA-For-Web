import type { StudioProject } from '@rea-studio/schema';

/** Match the adapter's filename fallback using only this authorized upload's label. */
export function projectForUpload(project: StudioProject, uploadName?: string): StudioProject {
  if (!uploadName || project.nodes.some((node) => node.kind === 'package' && node.path === 'package.json')) return project;
  return { ...project, target: { ...project.target, name: uploadName } };
}
