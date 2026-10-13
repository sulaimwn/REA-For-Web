# TASKS

One row per task. Claim before you start. Statuses: `todo` · `in progress` ·
`review` · `blocked` · `done`. Owners: `claude` · `codex` · `human`.

Details for a task go under its heading below the table.

| ID   | Task                                              | Owner | Status | Depends on |
| ---- | ------------------------------------------------- | ----- | ------ | ---------- |
| T001 | Generate real REA fixtures from open-source Electron apps | claude | done   | —          |
| T002 | Scaffold npm-workspaces monorepo (web, worker, packages) | codex | done   | —          |
| T003 | Define `StudioProject` schema from fixtures       | claude | done   | T001       |
| T004 | `rea-adapter`: REA JSON → `StudioProject`         | claude | done   | T003       |
| T005 | Web: static demo page rendering a fixture graph   | claude | done | T002, T004 |
| T006 | Worker: run REA on an `.asar` in a sandbox        | codex | done   | T002, T004 |
| T007 | Upload pipeline: presigned upload → queue → worker | codex | done | T006       |
| T008 | **Essential.** Per-file REA analysis of big bundles to avoid the shared result budget | —     | todo   | T006       |
| T009 | Adapter heuristics (labeled `studio-heuristic`): bridge linking; endpoint filtering is T012 | claude | done | T004       |
| T010 | Draft upstream REA issues: webpack-aliased Electron APIs, shared budget | claude | done | T001       |
| T011 | Launch prep: README + screenshots, shareable links, deploy notes | claude | done | T005       |
| T012 | **Essential.** Endpoint plausibility verdicts (schema proposal agreed in T015 review) | claude | review | T009       |
| T015 | Adapter: .asar inputs (asar-entry), fallback target name, appKind from any Electron process | claude | done | T004       |
| T013 | Local mode: CLI analyzes an app on your machine; web /open views the file (no upload) | claude | done | T004, T005 |
| T014 | VS Code demo (core subset): windows, bridges, named IPC channels | claude | done | T005       |
| T016 | Ask: question-answering toolkit + bring-your-own-key panel (also basis for demo tours and MCP) | claude | done | T013       |
| T017 | Guided-tour generator and viewer (recorded answers still pending API access) | claude | done | T016       |
| T018 | Cloudflare website deployment: demos, local mode and bring-your-own-key Ask | claude | done | T013, T016 |
| T020 | MIT license (the human's choice) | claude | done | — |
| T021 | **Essential.** Beyond Electron: plan + schema proposal for websites by URL, Android APKs, .NET, then native | —     | todo | T007 |
| T022 | **Essential.** MCP connector: Ask tools served over MCP (remote, on Cloudflare) | —     | todo | T016, T018 |
| T019 | UI redesign: drop the generic "AI-made" look; landing leads with the product | claude | done | T016, T017 |

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

**Integration ready for review:** Docker-only REA 6.4.0 runner, bounded input
preflight, streamed progress, T004 normalization inside the container,
`StudioProject` artifacts, cancellation, and container cleanup. Raw JSON stays
inside the container and is read only by the adapter. REA's dependency lock and
the Node image digest are pinned. A GitHub workflow builds the image and runs
five real Docker checks after push. 31 worker tests, 27 adapter tests, root
typecheck, and root build pass. Local Docker verification now passes all five
integration tests, plus all 31 worker unit tests and workspace typechecks.
Ready for cross-review. See
`notes/handoffs/2026-10-12-T006-codex-docker-verified.md`.

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

### T012 — Endpoint plausibility
Schema proposal agreed in `notes/handoffs/2026-10-12-T015-codex-review.md`
on `codex/T007-upload-pipeline`: preserve every REA endpoint candidate, add an
optional Studio heuristic assessment, and keep unassessed candidates visible.
Rule validated on full GitHub Desktop output: 2 of 89 endpoint candidates plausible,
exactly the two real ones. UI then hides `unlikely` endpoints by default.

### T019 — UI redesign
The human: the UI looks obviously AI-generated. Research the common tells (purple
accents, pill badges, centered hero + card row, glow, eyebrow labels) and redesign
from the product: a reverse-engineering evidence tool. Landing leads with the real
explorer. Restyle landing, explorer, inspector, Ask and /open. No behavior changes.

### T021 — Beyond Electron (essential)
The human: support for more than Electron is required for the final product. REA already has
tools for web bundles/pages, Android (APK), managed code (.NET) and native binaries. First step:
generate real REA fixtures for each target, then a schema proposal (new node kinds / appKind values)
for the other agent to agree before adapter work. Order: websites by URL, APK, .NET, native.

### T022 — MCP connector (essential)
Expose the Ask tools (`packages/ask`) as a remote MCP server so Claude and other clients can query
any analyzed project. Likely a Cloudflare Worker next to the site (needs T018).
