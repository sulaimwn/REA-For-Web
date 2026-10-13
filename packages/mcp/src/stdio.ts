#!/usr/bin/env node
// rea-for-web-mcp <project.studio.json>...: serves local REA for Web projects (made by
// `rea-studio analyze`) to an MCP client over stdio, e.g. Claude Desktop or Claude Code.
// Read-only; the files never leave this machine except as tool results to the client.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { StudioProject } from '@rea-studio/schema';
import { createReaMcpServer, summarize, type ProjectSource } from './server.js';

const USAGE = 'Usage: rea-for-web-mcp <project.studio.json> [more.studio.json ...]';

/** Enough of a shape check to fail clearly on the wrong file; tools tolerate the rest. */
function asProject(raw: unknown, file: string): StudioProject {
  const p = raw as Partial<StudioProject> | null;
  if (!p || typeof p !== 'object' || 'normalized_result' in p) {
    throw new Error(`${file} isn't a REA for Web project. Convert raw REA output with \`rea-studio analyze\` first.`);
  }
  if (typeof p.schemaVersion !== 'string' || !Array.isArray(p.nodes) || !Array.isArray(p.edges) || !p.target || typeof p.target.name !== 'string') {
    throw new Error(`${file} is missing project details. Export it again with \`rea-studio analyze\`.`);
  }
  return p as StudioProject;
}

/** Stable, readable ids: the app name, plus a counter if two files share one. */
function projectIds(projects: { project: StudioProject }[]): string[] {
  const used = new Map<string, number>();
  return projects.map(({ project }) => {
    const base = project.target.name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'project';
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0 || files.includes('--help') || files.includes('-h')) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = files.length === 0 ? 1 : 0;
    return;
  }
  const loaded = await Promise.all(
    files.map(async (file) => ({ file, project: asProject(JSON.parse(await readFile(file, 'utf8')), basename(file)) })),
  );
  const ids = projectIds(loaded);
  const byId = new Map(loaded.map((l, i) => [ids[i] as string, l]));
  const source: ProjectSource = {
    list: async () => [...byId].map(([id, l]) => summarize(id, l.project, basename(l.file))),
    load: async (id) => byId.get(id)?.project ?? null,
  };
  await createReaMcpServer(source).connect(new StdioServerTransport());
  // stdout carries the protocol; status goes to stderr.
  process.stderr.write(`REA for Web MCP server: ${[...byId.keys()].join(', ')}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
