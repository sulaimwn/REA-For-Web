# TASKS

One row per task. Claim before you start. Statuses: `todo` · `in progress` ·
`review` · `blocked` · `done`. Owners: `claude` · `codex` · `human`.

Details for a task go under its heading below the table.

| ID   | Task                                              | Owner | Status | Depends on |
| ---- | ------------------------------------------------- | ----- | ------ | ---------- |
| T001 | Generate real REA fixtures from open-source Electron apps | claude | done   | —          |
| T002 | Scaffold npm-workspaces monorepo (web, worker, packages) | codex | done   | —          |
| T003 | Define `StudioProject` schema from fixtures       | claude | done   | T001       |
| T004 | `rea-adapter`: REA JSON → `StudioProject`         | claude | review | T003       |
| T005 | Web: static demo page rendering a fixture graph   | —     | todo   | T002, T004 |
| T006 | Worker: run REA on an `.asar` in a sandbox        | —     | todo   | T002       |
| T007 | Upload pipeline: presigned upload → queue → worker | —     | todo   | T006       |
| T008 | Per-file REA analysis of big bundles to avoid the shared result budget | —     | todo   | T006       |
| T009 | Adapter heuristics (labeled `studio-heuristic`): bridge linking, endpoint filtering | —     | todo   | T004       |
| T010 | Draft upstream REA issues: webpack-aliased Electron APIs, shared budget | —     | todo   | T001       |

---

### T001 — Generate real REA fixtures
Install REA (`npm install --global rea-agents`) and run
`rea analyze-javascript-application <path> --json` against 2–3 **open-source**
Electron apps (e.g. GitHub Desktop, Element, Signal Desktop).
Save raw output to `fixtures/raw/<app>-<version>.json` (gitignored if huge — keep a
trimmed sample in `fixtures/samples/`). Write `fixtures/README.md` describing
what fields actually appear, output sizes, and run times.
**Done when:** at least one real fixture is committed and documented.

### T002 — Scaffold monorepo
Root `package.json` with npm workspaces for `apps/web`, `apps/worker`,
`packages/schema`, `packages/rea-adapter`. Shared `tsconfig.base.json`. Each
package builds and typechecks empty. Don't pick a UI framework beyond Next.js for
`apps/web`.
**Done when:** `npm install && npm run typecheck` passes from the root.

### T003 — Define `StudioProject` schema
Based **only** on what T001's fixtures contain, finalize the types in
`packages/schema`. Update the draft in `ARCHITECTURE.md` to match.

### T004 — rea-adapter
Pure function `toStudioProject(reaJson) → StudioProject` with tests against the
fixtures. Must handle large inputs without loading everything into the UI.

### T005 — Static demo page
Next.js page that loads a pre-generated `StudioProject` JSON and renders:
module tree (left), graph (middle, React Flow), evidence panel (right).
No backend.

### T006 — Analysis worker
Container that receives a file path, runs REA with CPU/RAM/time limits, no
network, non-root, and writes the adapter output. Never executes the target.

### T007 — Upload pipeline
Presigned upload to object storage (Cloudflare R2), SHA-256 dedupe, job queue,
results stored compressed, raw upload deleted after analysis.

### T008 — Per-file analysis of big bundles
In whole-app runs, 139/156 GitHub Desktop files lost their relationships to REA's
shared result budget; `main.js` analyzed alone had none. Try analyzing large
bundles individually (copy file + its `.map` + `package.json` to a temp dir) and
merging results. Measure time/RAM and what's recovered. See `fixtures/README.md`.

### T009 — Adapter heuristics
Studio-side inferences, always emitted with `origin.source = 'studio-heuristic'`:
link renderer `window.<apiKey>.<member>()` reads to `bridge-api` members; flag
plausible endpoints by `mechanism` (`call:fetch`, `call:request`, …) and value
shape. Never change REA facts; only add.

### T010 — Upstream REA issues (draft only)
Write issue drafts with minimal repros for: (1) `new r.BrowserWindow()` /
`r.ipcMain.handle()` via webpack externals not recognized; (2) shared parent
result budget dropping per-file relationships. The human decides whether to file.
