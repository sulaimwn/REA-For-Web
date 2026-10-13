// End-to-end over the real MCP protocol: SDK client ↔ in-memory transport ↔ our server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { toStudioProject } from '@rea-studio/rea-adapter';
import type { StudioProject } from '@rea-studio/schema';
import { createReaMcpServer, summarize, type ProjectSource } from '../src/server.js';

// Compiled to dist-tests/tests/, so the repo root is four levels up.
const samples = new URL('../../../../fixtures/samples/', import.meta.url);
const tiny = toStudioProject(JSON.parse(readFileSync(new URL('tiny-electron.rea-6.4.0.json', samples), 'utf8')), { reaVersion: '6.4.0' });
const source: ProjectSource = {
  list: async () => [summarize('tiny-electron', tiny, 'Tiny Electron sample')],
  load: async (id) => (id === 'tiny-electron' ? tiny : null),
};
const textOf = (r: unknown) => ((r as { content: { type: string; text: string }[] }).content[0] as { text: string }).text;

describe('REA for Web MCP server', () => {
  const client = new Client({ name: 'test', version: '0' });
  before(async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createReaMcpServer(source).connect(serverSide);
    await client.connect(clientSide);
  });
  after(() => client.close());

  it('advertises read-only tools, each Ask tool taking a project id', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['list_projects', 'project_overview', 'search_nodes', 'get_node', 'get_neighbors', 'find_path']);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
    for (const t of tools.slice(1)) assert.ok((t.inputSchema.required ?? []).includes('project'), t.name);
    assert.match(client.getInstructions() ?? '', /list_projects/);
    assert.equal(client.getServerVersion()?.name, 'rea-for-web');
  });

  it('lists projects and answers Ask tools against the chosen one', async () => {
    const list = JSON.parse(textOf(await client.callTool({ name: 'list_projects', arguments: {} }))) as { projects: { id: string; nodes: number }[] };
    assert.deepEqual(list.projects.map((p) => p.id), ['tiny-electron']);
    assert.equal(list.projects[0]?.nodes, tiny.nodes.length);

    const overview = JSON.parse(textOf(await client.callTool({ name: 'project_overview', arguments: { project: 'tiny-electron' } }))) as { app: { name: string } };
    assert.equal(overview.app.name, 'tiny-electron');

    const search = JSON.parse(textOf(await client.callTool({ name: 'search_nodes', arguments: { project: 'tiny-electron', query: 'notes:save', kind: 'ipc-channel' } }))) as { matches: { id: string; name: string }[] };
    assert.equal(search.matches[0]?.name, 'notes:save');

    const node = JSON.parse(textOf(await client.callTool({ name: 'get_node', arguments: { project: 'tiny-electron', id: search.matches[0]?.id } }))) as { kind: string; evidence: { items: unknown[] } };
    assert.equal(node.kind, 'ipc-channel');
    assert.ok(node.evidence.items.length > 0);
  });

  it('reports unknown projects and tools as tool errors, not protocol failures', async () => {
    const missing = await client.callTool({ name: 'project_overview', arguments: { project: 'nope' } });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /list_projects/);
    const unknown = await client.callTool({ name: 'delete_everything', arguments: {} });
    assert.equal(unknown.isError, true);
  });
});

describe('rea-for-web-mcp (stdio)', () => {
  const work = mkdtempSync(join(tmpdir(), 'rea-mcp-test-'));
  after(() => rmSync(work, { recursive: true, force: true }));

  it('serves a local .studio.json file to a real stdio client', async () => {
    const file = join(work, 'tiny.studio.json');
    writeFileSync(file, JSON.stringify(tiny satisfies StudioProject));
    const bin = fileURLToPath(new URL('../../dist/stdio.js', import.meta.url));
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, file], stderr: 'pipe' }));
    try {
      const list = JSON.parse(textOf(await client.callTool({ name: 'list_projects', arguments: {} }))) as { projects: { id: string; description: string }[] };
      assert.deepEqual(list.projects.map((p) => [p.id, p.description]), [['tiny-electron', 'tiny.studio.json']]);
      const path = await client.callTool({ name: 'find_path', arguments: { project: 'tiny-electron', from_id: tiny.nodes[0]?.id, to_id: tiny.nodes[1]?.id } });
      assert.notEqual(path.isError, true);
    } finally {
      await client.close();
    }
  });

  it('exits with a message for a file that is not a project', async () => {
    const raw = join(work, 'raw.json');
    writeFileSync(raw, JSON.stringify({ normalized_result: {} }));
    const bin = fileURLToPath(new URL('../../dist/stdio.js', import.meta.url));
    const child = spawn(process.execPath, [bin, raw], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += String(d)));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.equal(code, 1);
    assert.match(stderr, /isn't a REA for Web project/);
  });
});
