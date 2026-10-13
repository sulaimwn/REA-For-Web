# Architecture

## Pipeline

```
Browser
  │  1. hash file (SHA-256) → already analyzed? → return cached result
  │  2. presigned upload
  ▼
Object storage (R2)  ── raw upload, auto-deleted after analysis / 24h
  │
  ▼
Job queue
  │
  ▼
Analysis worker (sandboxed container: no network, non-root, CPU/RAM/time limits)
  │  rea analyze-javascript-application <path> --format json   (rea-agents@6.4.0)
  ▼
packages/rea-adapter  ── raw REA JSON → StudioProject
  │
  ▼
Results store (compressed StudioProject, keyed by file hash)
  │
  ▼
Graph API  →  Browser UI (tree · graph · evidence)
```

### Ask (`packages/ask`)

```
question ──► Claude (Messages API, manual tool loop, ≤ 8 tool rounds)
               ▲   │ tool_use
               │   ▼
        tool_result  ASK_TOOLS over one StudioProject (read-only, size-capped):
                     project_overview · search_nodes · get_node · get_neighbors · find_path
               │
               ▼
answer (markdown; nodes linked as [name](node:<id>)) ──► explorer shows the cited nodes
```

- One toolkit, three hosts: the browser Ask panel (bring your own key, `dangerouslyAllowBrowser`;
  the key never touches our servers), Node scripts for pre-generated demo tours, and a future
  MCP connector. No StudioProject data leaves the browser except what the model asks for through tools.
- Requests: default `claude-opus-5-5` (Sonnet 5.5 / Haiku 5.5 selectable), `output_config.effort: medium`,
  top-level `cache_control` (tools + system + history are cached across rounds), `fallbacks: "default"`
  on Opus/Sonnet (server-side refusal fallback). Forced `tool_choice` isn't allowed on these models,
  so the last round sends a mid-conversation system note plus `tool_choice: none`.
- Citations are validated against the project; unknown ids are dropped.

### Local mode (no upload, no server)

```
user's machine:  rea-studio analyze <app>  ──►  REA (rea-agents@6.4.0)  ──►  rea-adapter  ──►  <app>.studio.json
browser:         /open  ──  file read with FileReader, shape-checked, rendered by the same explorer
```

The CLI (`apps/cli`) uses the same adapter as the worker, so a local project and an
uploaded one are identical `StudioProject`s. The `/open` page never sends the file
anywhere, which also makes it work on a static deploy.

## Repo layout

```
apps/
  web/            Next.js frontend + API routes
  worker/         analysis worker (runs REA)
packages/
  schema/         StudioProject types — the contract between everything
  rea-adapter/    the ONLY code that reads raw REA output
fixtures/         real REA output used for development and tests
notes/handoffs/   agent handoff notes
```

## Key rules

- The UI never sees raw REA output. REA changes fast; only the adapter changes
  with it.
- Don't store uploaded binaries long-term. Store only normalized results.
- Dedupe by file hash — the same app version is only ever analyzed once.

## Scope

- **Local mode:** Electron/JS (`.asar` or extracted app dir), managed .NET/native
  Windows programs (`.exe`/`.dll`), Android APKs, and website URLs. Program files are analyzed statically;
  website capture loads the requested page in a fresh Chrome profile, then
  analyzes captured scripts statically.
- **Analysis worker:** Electron/JS with bounded per-file recovery, .NET, native
  Ghidra and Android JADX pass local integration checks. The provider-independent
  host deployment is prepared in T026, but public hosting/R2/TLS are not connected.
  Isolated website capture still needs its separate worker design.
- **Never on the server:** runtime/process capture of uploaded targets.

## StudioProject schema (v0.1.0)

The source of truth is [`packages/schema/src/index.ts`](packages/schema/src/index.ts).
It was derived from the real REA 6.4.0 fixtures in `fixtures/` (see
`fixtures/README.md`). This section summarizes it.

```ts
interface StudioProject {
  schemaVersion: '0.1.0';
  id: string;                    // artifact digest, or capture evidence identity for a URL
  target: TargetInfo;            // name, version, sha256, format, appKind
  analysis: AnalysisInfo;        // engine + version, coverage, limitations, stats, omitted parts
  findings: FindingCoverage[];   // one per category: found / not-found / confirmed-absent
  ipcSummary: IpcSummary;        // REA summary.ipc, renamed
  nodes: StudioNode[];           // discriminated union on `kind`
  edges: StudioEdge[];           // REA relation names, verbatim
}
```

### Design rules

T021 adds `appKind: dotnet | web`, `format: pe | url`, and the assembly,
managed-type, managed-method, native-import and external-member node kinds.
Managed fields are listed on their type; managed calls come from REA's member
inspection. Findings are target-specific. The additive schema remains 0.1.0,
and existing Electron projects remain readable. For URLs, `target.sha256`
stores the capture identity rather than a nonexistent single-file digest.

T012's optional endpoint assessment preserves REA's candidates and separately
labels the Studio verdict. T008 recovery preserves original observations and
labels any path-based relative-import resolution as a Studio heuristic.

1. **Evidence on everything.** Every node has `evidence[]` (one per REA observation);
   every edge has one `evidence`. Evidence keeps REA's `state`
   (`observed` / `inferred` / `unavailable`), categorical `confidence`
   (`exact` > `high` > `medium` > `low` > `unknown`), `authority`, `extractor`,
   `location` (file + line/column range, or file only), and `limitations`.
   **No numeric confidence scores**, ever.
2. **Origin is explicit.** `origin: { source: 'rea' }` for REA facts.
   Anything Studio infers on top (bridge linking, endpoint filtering, etc.) uses
   `{ source: 'studio-heuristic', heuristic, basis }` and the UI must label it.
3. **"Not found" ≠ "absent".** `findings[]` has one `FindingCoverage` per
   category (`source-files`, `imports`, `processes`, `windows`, `ipc`,
   `bridge-apis`, `native-addons`, `endpoints`, `storage`, `workers`) with
   `status`, `count`, `unresolvedCount`, `coverage`, and `notes`.
   REA static analysis never proves absence, so the adapter emits `not-found`,
   never `confirmed-absent`. That value is reserved for future evidence sources.
4. **Gaps are first-class.** REA `unknown` nodes become `analysis-gap` nodes;
   files whose relationships REA dropped carry `FileNode.analysisIssue`;
   `analysis.coverage` and `analysis.limitations` are passed through.
5. **Recovered source ≠ shipped code.** `source-file` nodes are original files
   recovered from source maps (`app/src/ui/history/compare.tsx`).
   `file` / `module` / `bundle-chunk` nodes are what actually ships.
   REA 6.4.0 gives source files no import edges; don't fake them.
6. **v0.1 omits** REA's semantic (dataflow) graph (~75% of output bytes) and
   export-shape nodes. `analysis.omitted` records this.

### REA → Studio mapping (for T004)

| REA node kind | Studio kind | Notes |
|---|---|---|
| `package` | `package` | |
| `javascript-asset`, `artifact` | `file` | `artifact root` becomes the tree root; `projection failure` → `analysisIssue` |
| `asar-entry` (`.asar` inputs only) | folded into the `file` it `maps_to` | root `contains` is re-pointed to that file and the entry's evidence is appended to it; an entry that maps to nothing becomes a `file` with `fileKind: 'other'` |
| `source-module` | `source-file` | path from `source_map_reference.resolution.path` |
| `source-map` | `source-map` | `available: false` when referenced but not shipped |
| `javascript-module`, `semantic_role: source-module` | `module` | `exportNames` from its `export_names` property |
| `javascript-module`, no role, has `module_key` + `bundler` | `module` with `bundler` set | a module recovered from inside a bundle chunk |
| `javascript-module`, `semantic_role: module-reference` (`external` / `not-found`) | `external-module` | **dedupe bare specifiers** (`electron`, `node:path`) into id `external-module:<specifier>`; relative ones (`./types.js`) stay separate |
| `javascript-module`, no role, has `reference_kind` + `resolution: unresolved` | `external-module` (`unresolved`) | e.g. `require('electron')`; same dedupe |
| `javascript-module`, `semantic_role: export-binding` / `export-return-shapes` | dropped | names kept on `module.exportNames` |

A REA node can carry several observations with different roles; classify by
the first observation that matches a row above, in table order. Counts seen:
tiny-electron 20 observations, GitHub Desktop 1,145 (641 unresolved references,
256 module-references, 198 export nodes, 50 modules).
| `javascript-chunk` | `bundle-chunk` | |
| `electron-main` / `electron-renderer` / `electron-preload` | `process` | `role` = main / renderer / preload |
| `browser-window` | `window` | |
| `context-bridge-api` | `bridge-api` | |
| `ipc-channel` | `ipc-channel` | `channel: null` + `channelExpression` when dynamic |
| `ipc-handler` | `ipc-handler` | |
| `native-addon` | `native-addon` | |
| `endpoint` | `endpoint` | passed through unfiltered; filtering is a heuristic |
| `storage` | `storage` | |
| `worker` | `worker` | |
| `unknown` | `analysis-gap` | |

Relations (`contains`, `imports`, `exposes`, `loads`, `maps_to`, `invokes`,
`sends`, `handles`, `calls`, `persists_to`) are kept verbatim. Edges whose
endpoints were dropped (export-shape nodes) are dropped too, and edges to
deduplicated external modules are re-pointed at the merged node.
REA node kinds the adapter doesn't recognize become `analysis-gap` nodes
(operation `studio-adapter:unrecognized-rea-node:<kind>`) rather than vanishing.

### Adapter API (`@rea-studio/rea-adapter`)

```ts
toStudioProject(rawReaJson: unknown, { reaVersion: '6.4.0', targetName?: string }): StudioProject
adaptReaResult(rawReaJson, { reaVersion }): { project: StudioProject; report: AdapterReport }
```

- Input is the parsed stdout of `rea analyze-javascript-application --format json`.
  REA's JSON doesn't contain its own package version, so the caller passes it.
  `targetName` (e.g. the uploaded file's original name) is used when REA reports no root
  `package.json`; otherwise the name falls back to REA's input path (`target.asar` in the sandbox).
- Throws `ReaOutputError` if the input isn't an `analyze_javascript_application` result.
- `AdapterReport` (not part of the schema) counts dropped and merged nodes and edges, for logs.
- Measured on GitHub Desktop: 50 MB REA JSON → 4.5 MB StudioProject; 0.4 s to parse, 19 ms to adapt.

### Studio heuristics

Heuristics only **add** edges; they never change or remove REA facts. Every
heuristic edge has `origin: { source: 'studio-heuristic', heuristic, basis }`,
`inferred` evidence, and `authority: 'studio-heuristic'`. `AdapterReport.heuristicEdges`
counts them by name.

| Heuristic | Adds | Rule | Confidence |
|---|---|---|---|
| `bridge-member-read` | `<file> --calls--> <bridge-api>` | REA's semantic graph records a property read `[apiKey, member]` (from `window.notesApi.save`) in that file, and a `bridge-api` exposes that `apiKey` with that member. Location = the read site. | `medium` (name match only) |

This is the only use of REA's semantic graph; the graph itself is still not
copied into `StudioProject`.

### Example (from the tiny-electron fixture, abbreviated)

```json
{
  "id": "ipc-channel:notes:save",
  "kind": "ipc-channel",
  "label": "notes:save",
  "channel": "notes:save",
  "channelExpression": null,
  "resolution": "literal",
  "usages": [
    { "side": "renderer", "operation": "invoke" },
    { "side": "main", "operation": "handle" }
  ],
  "origin": { "source": "rea" },
  "evidence": [
    {
      "state": "observed", "confidence": "exact",
      "authority": "ast-static-analysis", "extractor": "observe-ipc-channel-expression",
      "location": { "kind": "source-range", "file": "src/preload.js",
                    "start": { "line": 4, "column": 18 }, "end": { "line": 4, "column": 56 } },
      "limitations": []
    },
    {
      "state": "observed", "confidence": "exact",
      "authority": "ast-static-analysis", "extractor": "observe-ipc-channel-expression",
      "location": { "kind": "source-range", "file": "src/main/main.js",
                    "start": { "line": 17, "column": 0 }, "end": { "line": 17, "column": 68 } },
      "limitations": []
    }
  ]
}
```

(Real ids are REA `node_id`s such as `jag_node_…`; the id above is shortened.
All other values are copied from the fixture.)

## API (DRAFT)

- `POST /api/uploads` → `{ uploadUrl, jobId }` or `{ projectId }` if hash is cached
- `GET  /api/jobs/:id` → `{ status, projectId? , error? }`
- `GET  /api/projects/:id/graph` → `{ nodes, edges }` (paginated/collapsed)
- `GET  /api/projects/:id/nodes/:nodeId` → node detail + evidence

## Implemented upload API (T007)

The draft hash-first cache lookup is intentionally deferred: knowing a hash must
not grant access to someone else's private result. Each upload receives a random
job token, kept out of URLs. Cache reuse occurs only after actual file bytes are
verified. Uploaded file hashes and REA project ids are stored separately.

- `POST /api/uploads` accepts `{name, bytes, sha256}` and returns
  `{uploadUrl, headers, jobId, jobToken, expiresAt}`.
- `POST /api/uploads/:id/complete` queues the finalized upload idempotently.
- `GET /api/jobs/:id` returns status, bounded REA progress text, and projectId on
  success. Job reads and completion require a bearer job token.
- `GET /api/jobs/:id/project` streams compressed StudioProject JSON to the
  existing explorer. Paginated graph/node endpoints remain future work.

`packages/pipeline` contains browser-safe API contracts, local/R2 object storage,
Redis/BullMQ job control, and the trusted orchestration processor. The web and
queue host use its separate entry points. Only the existing adapter handles REA
JSON inside the sandbox; the upload pipeline moves bytes and StudioProject.
The analysis image has no storage credentials or network access. See
`docs/uploads.md` for setup, private-beta access and retention guarantees.
Upload job status may include `uploadName`, returned only after authorizing that
job. Shared cached projects use `target.<kind>` when artifact metadata is missing;
the viewer applies the current job's filename as the adapter's fallback. Package
names recovered from the artifact stay unchanged. An uploader's filename is
never reused as another uploader's cache label.

T025 extends filename admission to `.asar`, `.exe`, `.dll` and `.apk` without new
request/response fields. Staging preserves the kind; revision 7 cache keys include
the kind, preventing cross-parser cache reuse when the same bytes are renamed.
Raw object names and expiry support all four kinds. Old authorized ASAR results
from revisions 2–6 remain readable. Native image selection stays operator-owned.

T026 packages the existing API/explorer as a non-root Linux web container, with
private Redis and a trusted host queue service. Only the host queue controls
Docker; analysis containers remain offline and credential-free. The Cloudflare
frontend may use the public `REA_UPLOAD_ORIGIN` runtime setting to link to that
service's `/upload`; each service keeps its own browser session/job tokens.
This does not add API fields or a cross-origin proxy. See `docs/hosted-uploads.md`.
