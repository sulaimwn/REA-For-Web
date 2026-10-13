// Generates guided tours: pre-answered Ask questions for each demo, committed to
// apps/web/tours/<slug>.json so visitors can read them without an API key.
//
// Costs real API usage (a few cents per question on Opus 5.5). Run it yourself:
//   ANTHROPIC_API_KEY=sk-ant-... npm run tours -w @rea-studio/web               # all demos
//   ANTHROPIC_API_KEY=sk-ant-... npm run tours -w @rea-studio/web -- tiny-electron
// Requires built packages (`npm run build:packages`).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { askProject } from '@rea-studio/ask';
import { toStudioProject } from '@rea-studio/rea-adapter';

const MODEL = 'claude-opus-5-5';
const samples = new URL('../../../fixtures/samples/', import.meta.url);
const outDir = new URL('../tours/', import.meta.url);

/** Curated questions per demo. Keep them answerable from what REA actually recovered. */
const TOURS = {
  'tiny-electron': {
    file: 'tiny-electron.rea-6.4.0.json',
    questions: [
      'How does a note get saved, from the Save button to the file on disk?',
      'What does the preload script expose to the web page, and what does each part do?',
    ],
  },
  'github-desktop': {
    file: 'github-desktop-3.6.5.trimmed.rea-6.4.0.json',
    questions: [
      'What does GitHub Desktop keep in localStorage, and which code reads or writes it?',
      'What native modules does it ship, and what are they likely for?',
      'How do the renderer and main process communicate, and what could REA not resolve?',
    ],
  },
  'vscode-core': {
    file: 'vscode-core-1.141.0.trimmed.rea-6.4.0.json',
    questions: [
      'What windows does VS Code create, and what do its preload scripts expose?',
      'What IPC channels does the browser-view preload use, and in which direction?',
    ],
  },
};

const PRICE = { in: 4, out: 20, read: 0.2 }; // USD per million tokens, claude-opus-5-5

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY first. This spends API credit (a few cents per question).');
  process.exit(1);
}

const only = process.argv.slice(2);
const client = new Anthropic();
mkdirSync(outDir, { recursive: true });
let totalCost = 0;

for (const [slug, { file, questions }] of Object.entries(TOURS)) {
  if (only.length && !only.includes(slug)) continue;
  let raw;
  try {
    raw = JSON.parse(readFileSync(new URL(file, samples), 'utf8'));
  } catch {
    console.warn(`skip ${slug}: fixture ${file} not found`);
    continue;
  }
  const project = toStudioProject(raw, { reaVersion: '6.4.0' });
  const tours = [];
  for (const question of questions) {
    const steps = [];
    process.stdout.write(`${slug}: ${question}\n`);
    const r = await askProject({ client, project, question, model: MODEL, onStep: (s) => s.type === 'tool' && steps.push({ name: s.name, input: s.input }) });
    const cost = (r.usage.inputTokens * PRICE.in + r.usage.cacheWriteTokens * PRICE.in * 1.25 + r.usage.cacheReadTokens * PRICE.read + r.usage.outputTokens * PRICE.out) / 1e6;
    totalCost += cost;
    console.log(`  ${r.toolCalls} lookups, ${r.citedNodeIds.length} cited nodes, ≈ $${cost.toFixed(3)}`);
    tours.push({ question, answer: r.answer, citedNodeIds: r.citedNodeIds, steps, model: r.model });
  }
  const doc = { slug, projectId: project.id, schemaVersion: project.schemaVersion, generatedAt: new Date().toISOString(), tours };
  writeFileSync(new URL(`${slug}.json`, outDir), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote tours/${slug}.json`);
}
console.log(`total ≈ $${totalCost.toFixed(3)}`);
