// Server-only: reads the demo index written by scripts/build-demo-projects.mjs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DemoEntry } from './project';

export function loadDemos(): DemoEntry[] {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), 'public', 'projects', 'index.json'), 'utf8')) as DemoEntry[];
  } catch {
    return []; // Not generated yet: run `npm run demo-data --workspace=@rea-studio/web`.
  }
}
