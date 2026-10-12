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
  │  rea analyze-javascript-application <path> --json
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

## StudioProject schema (DRAFT — finalize in T003 from real fixtures)

```ts
type StudioProject = {
  app: { name: string; version?: string; kind: "electron" };
  nodes: StudioNode[];        // modules, grouped by layer
  edges: StudioEdge[];        // imports, IPC, native links
  ipcChannels: IPCChannel[];
  nativeModules: NativeModule[];
  evidence: Evidence[];       // each node/edge points to evidence ids
};
```

This is a guess until T001 shows what REA actually returns. Don't build on it yet.

## API (DRAFT)

- `POST /api/uploads` → `{ uploadUrl, jobId }` or `{ projectId }` if hash is cached
- `GET  /api/jobs/:id` → `{ status, projectId? , error? }`
- `GET  /api/projects/:id/graph` → `{ nodes, edges }` (paginated/collapsed)
- `GET  /api/projects/:id/nodes/:nodeId` → node detail + evidence
