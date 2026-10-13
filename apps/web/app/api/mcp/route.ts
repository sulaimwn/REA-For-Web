// Public MCP endpoint (T022): the demo projects' Ask tools over Streamable HTTP.
// Add https://<site>/api/mcp as a connector in an MCP client. Read-only and stateless:
// a new server per request, JSON responses, no sessions.
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createReaMcpServer, type ProjectSource } from '@rea-studio/mcp';
import type { StudioProject } from '@rea-studio/schema';
import { loadDemos } from '../../../lib/demos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Public, read-only data: any origin may call it (e.g. browser-based MCP inspectors).
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

/** Demo projects are immutable per deploy, so keep parsed ones for the life of this server instance. */
const projects = new Map<string, Promise<StudioProject | null>>();

/** On Cloudflare, read the demo JSON through the static-assets binding; elsewhere fetch it from this origin. */
async function fetchAsset(url: URL): Promise<Response> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    const assets = (getCloudflareContext().env as { ASSETS?: { fetch(input: URL): Promise<Response> } }).ASSETS;
    if (assets) return await assets.fetch(url);
  } catch {
    // Not running on Cloudflare (next dev / next start).
  }
  return fetch(url);
}

function demoSource(origin: string): ProjectSource {
  const demos = loadDemos();
  return {
    list: async () =>
      demos.map((d) => ({ id: d.slug, name: d.title, version: d.version, appKind: d.appKind, nodes: d.nodes, links: d.edges, description: d.blurb })),
    load: (id) => {
      if (!demos.some((d) => d.slug === id)) return Promise.resolve(null);
      let project = projects.get(id);
      if (!project) {
        project = fetchAsset(new URL(`/projects/${id}.json`, origin)).then((r) => (r.ok ? (r.json() as Promise<StudioProject>) : null));
        project.catch(() => projects.delete(id)); // retry a failed load next time
        projects.set(id, project);
      }
      return project;
    },
  };
}

async function handle(request: Request): Promise<Response> {
  const server = createReaMcpServer(demoSource(new URL(request.url).origin));
  // No sessionIdGenerator: stateless mode, which suits a read-only server on short-lived instances.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export { handle as GET, handle as POST, handle as DELETE };

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
