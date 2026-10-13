# Ask REA for Web from Claude (MCP)

REA for Web serves its analyses over the [Model Context Protocol](https://modelcontextprotocol.io),
so Claude (or any MCP client) can answer questions about an app with the same evidence the
explorer shows. The tools are read-only.

| Tool | What it does |
|---|---|
| `list_projects` | The analyzed apps available, with the `project` id the other tools take |
| `project_overview` | Name, version, coverage, findings and node counts. Call this first |
| `search_nodes` | Find parts by name, path, export or member, optionally one kind |
| `get_node` | Everything about one part, with REA's evidence (file:line, observed/inferred, confidence) |
| `get_neighbors` | Its links: imports, IPC, loads, calls, storage writes… with evidence |
| `find_path` | The shortest chain of links between two parts (up to 8 hops) |

## The website's demos (remote)
The site serves its demo apps at **`https://<your site>/api/mcp`**, e.g. `https://reaforweb.com/api/mcp` once deployed.
- **Claude (web or desktop):** Settings → Connectors → Add custom connector, then paste the URL.
- **Claude Code:** `claude mcp add --transport http rea-for-web https://reaforweb.com/api/mcp`

The endpoint is stateless Streamable HTTP with JSON responses (no sessions). It serves the same demo
files the explorer loads.

## Your own apps (local, nothing uploaded)
1. Analyze the app: `npm run analyze -w rea-studio -- path/to/app.asar`. This writes `app.studio.json`; see `apps/cli`.
2. Build the server once: `npm run build:packages && npm run build -w @rea-studio/mcp`.
3. Point your client at the file. Several files can be given at once.
   - **Claude Code:** `claude mcp add rea-for-web -- node /path/to/repo/packages/mcp/dist/stdio.js /path/to/app.studio.json`
   - **Claude Desktop** (`claude_desktop_config.json`):
     ```json
     { "mcpServers": { "rea-for-web": {
         "command": "node",
         "args": ["/path/to/repo/packages/mcp/dist/stdio.js", "/path/to/app.studio.json"] } } }
     ```

## Notes
- Tool results include text taken from the analyzed app (strings, paths). The server's instructions tell
  the model to treat it as data, never as instructions. Clients should do the same.
- "Not found" never proves absence: REA is static analysis.
- Results tagged `studio-heuristic` are REA for Web's inferences on top of REA's facts. Examples: bridge links (T009) and endpoint verdicts (T012).
- Code: `packages/mcp` (server and stdio binary) and `apps/web/app/api/mcp/route.ts`. SDK: `@modelcontextprotocol/sdk` 1.31.0 (pinned).
