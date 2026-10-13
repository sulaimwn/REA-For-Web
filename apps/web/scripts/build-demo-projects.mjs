// Builds static StudioProject JSON for the demo from the committed REA fixtures.
// Output: apps/web/public/projects/<slug>.json and index.json (gitignored; rebuilt
// before dev/build). Requires @rea-studio/rea-adapter to be built first.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { toStudioProject } from '@rea-studio/rea-adapter';
import { publishTourFile } from './tour-data.mjs';

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
  {
    slug: 'reaforweb-site',
    title: 'This website',
    file: 'reaforweb-dev-landing.web-bundle.rea-6.4.0.json',
    blurb: 'REA for Web’s own landing page, captured in a headless browser: its scripts, the frameworks they use and endpoint candidates.',
    note: 'Captured from a development build on localhost, so the scripts are unminified dev chunks',
  },
  {
    slug: 'tiny-dotnet',
    title: 'Tiny .NET sample',
    file: 'tiny-dotnet.rea-6.4.0.json',
    blurb: 'A hand-written C# program: types, methods, its call graph and three calls into native code.',
  },
  {
    slug: 'tiny-native',
    title: 'Tiny Windows .exe',
    file: 'tiny-native.rea-6.4.0.json',
    blurb: 'A hand-written C program read with Ghidra: its functions, the Windows APIs each one calls, a URL, a file and a registry key.',
  },
  {
    slug: 'tiny-linux',
    title: 'Tiny Linux program',
    file: 'tiny-linux.rea-6.4.0.json',
    blurb: 'The same idea as a Linux ELF, read with Ghidra: its functions, the C library calls each one makes, a URL and two files.',
  },
  {
    slug: 'tiny-android',
    title: 'Tiny Android app',
    file: 'tiny-android.rea-6.4.0.json',
    blurb: 'A hand-written APK read with JADX: its activity, service, receiver and provider, permissions, and the WebView’s JavaScript bridge.',
  },
  // Real-world samples (T031): small open-source apps; sources and checksums in fixtures/sample-apps/real-world.md.
  {
    slug: 'caprine',
    title: 'Caprine (Electron)',
    file: 'caprine-2.61.0.trimmed.rea-6.4.0.json',
    blurb: 'An open-source Messenger desktop app: its main, preload and renderer processes, the window and the IPC channels between them.',
    note: 'Trimmed sample: dependency files under node_modules are left out',
  },
  {
    slug: 'jq',
    title: 'jq (Windows .exe)',
    file: 'jq-1.8.2-windows.rea-6.4.0.json',
    targetName: 'jq.exe',
    blurb: 'The popular JSON command-line tool, read with Ghidra: about 900 functions and the Windows APIs they call. Release builds are stripped, so most functions have Ghidra’s generic names.',
  },
  {
    slug: 'binary-eye',
    title: 'Binary Eye (Android)',
    file: 'binaryeye-1.75.5.rea-6.4.0.json',
    blurb: 'An open-source barcode scanner from F-Droid, read with JADX: its 18 components, 11 permissions and readable classes. Most classes were renamed by a minifier and are left out.',
  },
];

/**
 * Copies committed guided tours (apps/web/tours/<slug>.json, from scripts/generate-tours.mjs)
 * next to the project, but only if they were generated for this exact project: tour answers
 * link node ids, which change when the fixture or adapter output changes.
 */
function publishTours(slug, project) {
  return publishTourFile(slug, project, new URL(`../tours/${slug}.json`, import.meta.url), new URL(`${slug}.tours.json`, out));
}

mkdirSync(out, { recursive: true });
const index = DEMOS.map(({ slug, title, file, blurb, note, targetName }) => {
  const raw = JSON.parse(readFileSync(new URL(file, samples), 'utf8'));
  const project = toStudioProject(raw, { reaVersion: REA_VERSION, ...(targetName ? { targetName } : {}) });
  writeFileSync(new URL(`${slug}.json`, out), JSON.stringify(project));
  const trim = raw._fixture_trim?.graph;
  const tours = publishTours(slug, project);
  return {
    slug,
    title,
    blurb,
    name: project.target.name,
    version: project.target.version,
    appKind: project.target.appKind,
    nodes: project.nodes.length,
    edges: project.edges.length,
    coverage: project.analysis.coverage.status,
    sample: [note, trim && trim.nodes_kept < trim.nodes_original ? `Trimmed fixture: ${trim.nodes_kept} of ${trim.nodes_original} REA nodes kept` : null]
      .filter(Boolean)
      .join('. ') || null,
    tours,
  };
});
writeFileSync(new URL('index.json', out), JSON.stringify(index, null, 2));
console.log(`demo projects: ${index.map((d) => `${d.slug} (${d.nodes} nodes)`).join(', ')}`);
