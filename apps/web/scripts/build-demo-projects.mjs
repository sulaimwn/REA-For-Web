// Builds static StudioProject JSON for the demo from the committed REA fixtures.
// Output: apps/web/public/projects/<slug>.json and index.json (gitignored; rebuilt
// before dev/build). Requires @rea-studio/rea-adapter to be built first.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { toStudioProject } from '@rea-studio/rea-adapter';

const REA_VERSION = '6.4.0';
const samples = new URL('../../../fixtures/samples/', import.meta.url);
const out = new URL('../public/projects/', import.meta.url);

const DEMOS = [
  {
    slug: 'github-desktop',
    title: 'GitHub Desktop',
    file: 'github-desktop-3.6.5.trimmed.rea-6.4.0.json',
    blurb: 'A real, webpack-bundled Electron app (open source, MIT).',
  },
  {
    slug: 'tiny-electron',
    title: 'Tiny Electron sample',
    file: 'tiny-electron.rea-6.4.0.json',
    blurb: 'A 7-file hand-written app with a known answer key.',
  },
];

/**
 * Copies committed guided tours (apps/web/tours/<slug>.json, from scripts/generate-tours.mjs)
 * next to the project, but only if they were generated for this exact project: tour answers
 * link node ids, which change when the fixture or adapter output changes.
 */
function publishTours(slug, projectId) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(new URL(`../tours/${slug}.json`, import.meta.url), 'utf8'));
  } catch {
    return 0;
  }
  if (doc.projectId !== projectId) {
    console.warn(`tours/${slug}.json is stale (made for another project version); regenerate with \`npm run tours -w @rea-studio/web -- ${slug}\``);
    return 0;
  }
  writeFileSync(new URL(`${slug}.tours.json`, out), JSON.stringify(doc));
  return doc.tours.length;
}

mkdirSync(out, { recursive: true });
const index = DEMOS.map(({ slug, title, file, blurb }) => {
  const raw = JSON.parse(readFileSync(new URL(file, samples), 'utf8'));
  const project = toStudioProject(raw, { reaVersion: REA_VERSION });
  writeFileSync(new URL(`${slug}.json`, out), JSON.stringify(project));
  const trim = raw._fixture_trim?.graph;
  const tours = publishTours(slug, project.id);
  return {
    slug,
    title,
    blurb,
    name: project.target.name,
    version: project.target.version,
    nodes: project.nodes.length,
    edges: project.edges.length,
    coverage: project.analysis.coverage.status,
    sample: trim ? `Trimmed fixture: ${trim.nodes_kept} of ${trim.nodes_original} REA nodes kept` : null,
    tours,
  };
});
writeFileSync(new URL('index.json', out), JSON.stringify(index, null, 2));
console.log(`demo projects: ${index.map((d) => `${d.slug} (${d.nodes} nodes)`).join(', ')}`);
