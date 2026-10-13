// Build-time manifest: independent of the directory used to start the server.
import demoIndex from '../public/projects/index.json';
import type { DemoEntry } from './project';

export function loadDemos(): DemoEntry[] {
  // Callers may sort their list without changing the shared imported manifest.
  return [...demoIndex] as DemoEntry[];
}
