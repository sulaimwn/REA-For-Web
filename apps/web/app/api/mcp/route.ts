// Public MCP endpoint (T022): the demo projects' Ask tools over Streamable HTTP.
// Add https://<site>/api/mcp as a connector in an MCP client. Read-only and stateless:
// a new server per request, JSON responses, no sessions.
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createReaMcpServer, type ProjectSource } from '@rea-studio/mcp';
import type { StudioProject } from '@rea-studio/schema';
import { loadDemos } from '../../../lib/demos';
import { boundedMcpRequest, checkMcpOrigin, McpRequestError } from '../../../lib/mcp-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Public, read-only data: any origin may call it (e.g. browser-based MCP inspectors).
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

/** Demo projects are immutable per deploy, so keep parsed ones for the life of this server instance. */
const projects = new Map<string, Promise<StudioProject | null>>();

/** Read demos through Cloudflare's assets binding or local public build files. */
async function fetchAsset(id: string): Promise<StudioProject | null> {
  let assets: { fetch(input: URL): Promise<Response> } | undefined;
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    assets = (getCloudflareContext().env as { ASSETS?: typeof assets }).ASSETS;
  } catch {
    // Outside Cloudflare, read public build output directly. Never fetch a URL
    // derived from the incoming Host header, which a caller can control.
  }
  if (assets) {
    const response = await assets.fetch(new URL(`/projects/${id}.json`, 'https://rea-assets.invalid'));
    return response.ok ? await response.json() as StudioProject : null;
  }
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  for (const dir of ['public', 'apps/web/public']) {
    try { return JSON.parse(await readFile(join(process.cwd(), dir, 'projects', `${id}.json`), 'utf8')) as StudioProject; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read public demo data.');
    }
  }
  return null;
}

function demoSource(): ProjectSource {
  const demos = loadDemos();
  return {
    list: async () =>
      demos.map((d) => ({ id: d.slug, name: d.title, version: d.version, appKind: d.appKind, nodes: d.nodes, links: d.edges, description: d.blurb })),
    load: (id) => {
      if (!demos.some((d) => d.slug === id)) return Promise.resolve(null);
      let project = projects.get(id);
      if (!project) {
        project = fetchAsset(id);
        project.catch(() => projects.delete(id)); // retry a failed load next time
        projects.set(id, project);
      }
      return project;
    },
  };
}

export async function POST(request: Request): Promise<Response> {
  let bounded: Request;
  try {
    checkMcpOrigin(request);
    bounded = await boundedMcpRequest(request);
  } catch (error) {
    return Response.json({ error: error instanceof McpRequestError ? error.message : 'Invalid MCP request.' }, {
      status: error instanceof McpRequestError ? error.status : 400, headers: CORS,
    });
  }
  const server = createReaMcpServer(demoSource());
  // No sessionIdGenerator: stateless mode, which suits a read-only server on short-lived instances.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(bounded);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } finally { await server.close(); }
}

// Stateless JSON transport has neither sessions nor unsolicited SSE messages.
export function GET(request: Request) {
  try { checkMcpOrigin(request); }
  catch { return new Response(null, { status: 403, headers: CORS }); }
  return new Response(null, { status: 405, headers: { ...CORS, Allow: 'POST, OPTIONS' } });
}
export { GET as DELETE };

export function OPTIONS(request: Request) {
  try { checkMcpOrigin(request); }
  catch { return new Response(null, { status: 403, headers: CORS }); }
  return new Response(null, { status: 204, headers: CORS });
}
