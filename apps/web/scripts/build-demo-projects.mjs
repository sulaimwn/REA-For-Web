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
    slug: 'vscode-core',
    title: 'VS Code (core)',
    file: 'vscode-core-1.141.0.trimmed.rea-6.4.0.json',
    blurb: 'VS Code 1.141’s main process and preload scripts: windows, contextBridge APIs, named IPC channels.',
    note: 'Core subset: out/main.js, out/mainImpl.js and three preload scripts (VS Code ships no source maps)',
  },
  {
    slug: 'tiny-electron',
    title: 'Tiny Electron sample',
    file: 'tiny-electron.rea-6.4.0.json',
    blurb: 'A 7-file hand-written app with a known answer key.',
  },
];

mkdirSync(out, { recursive: true });
const index = DEMOS.map(({ slug, title, file, blurb, note }) => {
  const raw = JSON.parse(readFileSync(new URL(file, samples), 'utf8'));
  const project = toStudioProject(raw, { reaVersion: REA_VERSION });
  writeFileSync(new URL(`${slug}.json`, out), JSON.stringify(project));
  const trim = raw._fixture_trim?.graph;
  return {
    slug,
    title,
    blurb,
    name: project.target.name,
    version: project.target.version,
    nodes: project.nodes.length,
    edges: project.edges.length,
    coverage: project.analysis.coverage.status,
    sample: [note, trim && trim.nodes_kept < trim.nodes_original ? `Trimmed fixture: ${trim.nodes_kept} of ${trim.nodes_original} REA nodes kept` : null]
      .filter(Boolean)
      .join('. ') || null,
  };
});
writeFileSync(new URL('index.json', out), JSON.stringify(index, null, 2));
console.log(`demo projects: ${index.map((d) => `${d.slug} (${d.nodes} nodes)`).join(', ')}`);
