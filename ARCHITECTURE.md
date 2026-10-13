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

- **v0.1:** Electron/JS (`.asar` or extracted app dir), static analysis only.
- **Later:** APK (JADX), .NET, websites by URL, native via headless Ghidra.
- **Never on the server:** runtime/process capture of uploaded targets.

## StudioProject schema (v0.1.0)

The source of truth is [`packages/schema/src/index.ts`](packages/schema/src/index.ts).
It was derived from the real REA 6.4.0 fixtures in `fixtures/` (see
`fixtures/README.md`). This section summarizes it.

```ts
interface StudioProject {
  schemaVersion: '0.1.0';
  id: string;                    // = target.sha256 (cache / dedupe key)
  target: TargetInfo;            // name, version, sha256, format, appKind
  analysis: AnalysisInfo;        // engine + version, coverage, limitations, stats, omitted parts
  findings: FindingCoverage[];   // one per category: found / not-found / confirmed-absent
  ipcSummary: IpcSummary;        // REA summary.ipc, renamed
  nodes: StudioNode[];           // discriminated union on `kind`
  edges: StudioEdge[];           // REA relation names, verbatim
}
```

### Design rules

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
