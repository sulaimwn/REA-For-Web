import type { StudioProject } from '@rea-studio/schema';

/** Match the adapter's filename fallback using only this authorized upload's label. */
export function projectForUpload(project: StudioProject, uploadName?: string): StudioProject {
  const artifactName = project.nodes.find((node) => node.kind === 'file' && node.path === '')?.label;
  const namedByArtifact = project.nodes.some((node) =>
    (node.kind === 'assembly' && Boolean(node.name)) ||
    (node.kind === 'package' && (node.path === 'package.json' || (node.path === 'AndroidManifest.xml' && node.name !== artifactName))),
  );
  if (!uploadName || namedByArtifact) return project;
  return { ...project, target: { ...project.target, name: uploadName } };
}
