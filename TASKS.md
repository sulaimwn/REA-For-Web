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
| T008 | **Essential.** Per-file REA analysis of big bundles to avoid the shared result budget | claude | done | T006       |
| T009 | Adapter heuristics (labeled `studio-heuristic`): bridge linking; endpoint filtering is T012 | claude | done | T004       |
| T010 | Draft upstream REA issues: webpack-aliased Electron APIs, shared budget | claude | done | T001       |
| T011 | Launch prep: README + screenshots, shareable links, deploy notes | claude | done | T005       |
| T012 | **Essential.** Endpoint plausibility verdicts (schema proposal agreed in T015 review) | claude | done | T009       |
| T015 | Adapter: .asar inputs (asar-entry), fallback target name, appKind from any Electron process | claude | done | T004       |
| T013 | Local mode: CLI analyzes an app on your machine; web /open views the file (no upload) | claude | done | T004, T005 |
| T014 | VS Code demo (core subset): windows, bridges, named IPC channels | claude | done | T005       |
| T016 | Ask: question-answering toolkit + bring-your-own-key panel (also basis for demo tours and MCP) | claude | done | T013       |
| T017 | Guided-tour generator and viewer (recorded answers still pending API access) | claude | done | T016       |
| T018 | Cloudflare website deployment: demos, local mode and bring-your-own-key Ask | claude | done | T013, T016 |
| T020 | MIT license (the human's choice) | claude | done | — |
| T021 | **Essential.** Beyond Electron: .NET/web/native/Android adapters and local CLI | claude | done | T007 |
| T022 | **Essential.** MCP connector: Ask tools served over MCP (remote, on Cloudflare) | claude | done | T016, T018 |
| T024 | **Essential.** Program analysis worker: .NET, native Ghidra and Android JADX | claude | done | T006, T021 |
| T019 | UI redesign: drop the generic "AI-made" look; landing leads with the product | claude | done | T016, T017 |
| R001 | Independent integration review: T008, T012, T021 (.NET/web phase) and T022 | codex | done | T008, T012, T021, T022 |
| R002 | Independent review: T021 native/Android collectors, evidence and schema | codex | done | T021 |
| R003 | Independent review: T024 .NET/native/Android sandbox worker | codex | done | R002, T024 |
| T025 | Upload .exe/.dll/.apk files through the verified queue and sandbox | codex | done | T007, T024 |
| T026 | Hosted uploads: Linux web deployment, private queue and worker service | codex | done | T025 |
| T027 | Analysis speed: measure a per-file analysis cap for big bundled libraries; pre-analyze popular apps for instant results | claude | done | T025 |
| T028 | Linux programs (ELF) through REA's Ghidra provider: fixture with answer key, adapter, CLI, worker admission proposal | claude | done | T021, T024 |
| T030 | **Human request.** Free Ask tier: Cloudflare Workers AI open model with tool calls, per-visitor rate limit, no key needed; Claude key stays as the upgrade | claude | done | T016, T018 |
| T031 | **Human request.** Real-world sample projects (small open-source APK, .exe and Electron app, downloads approved by the human) as demos; uploads stay the main path | claude | done | T021, T028 |
| T029 | Bound progress persistence during queue outages so failed jobs still clean raw uploads and staging | codex | done | T025 |
| R004 | Independent review of Linux ELF evidence, CLI and sandbox worker | codex | done | T028 |
| T032 | Linux uploads: explicit .elf/.so admission with verified bytes and isolated ELF result cache | codex | done | T028, R004, T025 |
| T033 | Landing page: every supported format, "try your own app" first (upload or local), demos grouped into samples and real apps | claude | done | T031 |
| T034 | Operator pre-analysis: seed popular-file results through the verified upload queue without bypassing admission or sandbox limits | codex | done | T027, T032 |
| R005 | Independent release review: real-app demos, landing page and free Ask guards | codex | done | T030, T031, T033 |
| R006 | Independent review of T041 free Ask wire budgets and Workers AI deployment binding | codex | done | T041 |
| T035 | macOS programs (Mach-O) through REA's Ghidra provider on Linux: real fixture (jq 1.8.2 macOS), adapter format, CLI/worker admission by header | claude | done | T028, R004 |
| T036 | Bound stalled R2 operations across SDK retries so jobs release the queue and clean staging | codex | done | T026, T029 |
| T037 | **Human request.** Launch on reaforweb.com by 6 pm: favicon and app icons, site metadata for every format, custom-domain steps | claude | done | R005 |
| T038 | **Human goal.** Public launch by 6 pm Toronto: deployment/account checks, analysis-host choice and live verification | codex | done | T026, R005, T037 |
| T039 | Hosted uploads after a budget x86 8 GB server becomes available; human chose to wait for CX33 | codex | blocked | T026, T038 |
| T040 | Link-preview card on every page (Open Graph/X) and README pointing to reaforweb.com; follow-up to T037 | claude | done | T037 |
| T041 | Free Ask on the live site: wire-size conversation budget (36 KB) and the Workers AI binding, now that the plan is confirmed Workers Free | claude | done | T030, R005, T038 |
| T043 | Human request: refresh public README for the live project | codex | done | T038 |
| T042 | Reproduce and bound upload API commands when Redis accepts connections but stops replying | codex | done | T026, T029 |
| T044 | Verify real free Ask answers and node citations after the human deploys the reviewed AI-binding release | codex | done | T041, R006 |
| T045 | Readable overview for big programs: a call tree from the entry point instead of the first 250 parts by kind (jq, big .NET) | claude | done | T021, T031 |
| T046 | Faster program/APK analysis: job CPUs as an operator setting (`REA_ANALYSIS_CPUS`); measured Ghidra 139 s → 57 s on 2 CPUs; correct the worker's speed notes | claude | done | T024, T027 |
| R007 | Independently review T040 link-preview metadata, image and attribution | codex | done | T040 |
| R008 | Independently review T046 trusted operator CPU setting and unchanged sandbox defaults | codex | done | T046 |
| R009 | Independently review T035 macOS fixture, adapter, CLI and isolated worker | codex | done | T035 |
| R010 | Independently review T045 connected overview for large programs | codex | done | T045 |
| R011 | Independently review T049 macOS demo, named overview parts and import titles | codex | done | T049 |
| T048 | macOS uploads: verified .macho/.dylib admission with isolated Mach-O cache namespace | codex | done | T035, R009 |
| T049 | jq (macOS) demo: the real Mach-O fixture as a public demo, whose overview starts in jq’s own main | claude | done | T035, T045 |
| T053 | Worker crash recovery: measure orphan sandboxes and prevent restart overlap after abrupt queue death | codex | review | T026 |
| T052 | Object storage: reproduce and bound stalled response bodies after GET headers, with cleanup and recovery | codex | done | T036 |
| T051 | Linux tooling: reject mismatched queue ownership before local builds or hosted test services | codex | done | T050 |
| T050 | Hosted worker: reproduce Linux service UID mismatch and require readable private input ownership before startup | codex | done | T026 |
| T047 | Human request: visible website links to sulaimwn/REA-For-Web and morluto/rea | codex | done | T038 |

---

### T044 — Public free Ask verification
T041/R006 approve the implementation and Cloudflare configuration. After the
human pushes the reviewed release, inspect the deployment and ask an actual
question on the public Tiny Electron demo. Verify a real answer, tool lookups
and node citations. Until then, do not claim public free answers work. If deploy
fails due to Workers AI token permissions, have the human update the deploy
token through its normal account settings; never extract stored credentials or
change the Workers plan. Hosted uploads remain explicitly deferred under T039.

### T042 — Upload API Redis stalls
Exercise admission and completion with a dedicated real Redis instance paused
after connections are established. Bound the web-side Redis commands without
changing worker reconnect behavior, tokens, admission quotas, API/schema fields,
global analysis concurrency or sandbox limits. Verify failure returns promptly,
keeps raw uploads available for retry/expiry, and recovers without duplicate jobs.
Codex owns `packages/pipeline/src/server.ts` and the focused Redis integration
checks; leave Claude's active T035/T040/T041 files alone.

### T041 — Free Ask on the live site
Finish the R005 follow-up. Measure conversation size as JSON-escaped UTF-8 (`wireBytes`) and
raise the 8,000-byte total to 36,000, so free answers can use several tool results while staying
exactly inside the route's 64 KiB body limit. T038 confirmed the account is on Workers Free ($0),
where Workers AI stops at the daily allowance instead of billing, so enable the `ai` binding.
Codex reviews before merge. Never switch the plan or add a payment-backed model.

### T040 — Link-preview card
T037's second commit (`38e686f`), moved to its own branch because the T037 review covered only
`123369f`: `public/og-image.png`, shared Open Graph/X metadata for every page, and the README live link.

### T039 — Deferred analysis hosting
The human chose to wait for the US$10.59/month-before-tax CX33 rather than the
available US$42.59 CPX32. Keep public demos and local-project opening live.
Hetzner verification is complete, private R2/CORS/one-day raw-file cleanup are
configured, and no server has been purchased. Actual CX33 stock was unavailable
in all three European locations. Recheck on a later development wake; do not
select the more expensive host, lower sandbox limits or purchase automatically.
See `notes/handoffs/2026-10-13-T038-codex.md` for launch evidence and next steps.

### T036 — Object-storage deadlines
Reproduce the installed SDK's warning-only request timeout against a stalled
local HTTP storage service. Enforce a real deadline across retries for R2 reads,
metadata, publication, deletion and expiry requests. Verify failure leaves no
published job result and removes local staging; failed raw deletion remains
visible and recoverable through the existing lifecycle/expiry backstop. No API,
schema, admission or sandbox changes; avoid Claude's active native target files.

### T034 — Operator pre-analysis
Implement T027's proposed popular-file cache seeding as a trusted operator tool.
Hash a local file, optionally check a recorded release digest, then use normal
signed upload, completion and queue processing. Preserve global concurrency,
quota, possession verification, raw cleanup and private result access. No cache
imports from demo subsets, API/schema changes, hosting purchases or credentials.

### T032 — Linux uploads
Implement the explicit `.elf`/`.so` admission delegated to Codex in T028 and
proposed in the merged R004 handoff. Both extensions use the canonical `elf`
analysis kind. Keep all API fields, SHA possession checks, private storage,
sandbox limits and cleanup unchanged. Verify a real ELF through HTTP, alias
deduplication, and renamed PE rejection without cross-kind cache reuse. Bare and
versioned-library filenames remain outside this upload path.

### T029 — Queue progress recovery
Reproduce the processor waiting indefinitely on a Redis progress write, then
bound those writes without publishing a result whose progress persistence failed.
Verify failed analysis still removes its raw upload and staging, terminal errors
remain sanitized, and ordinary progress/result publication remains intact. No
upload API or schema changes; do not overlap Claude's speed/ELF work.

### T026 — Hosted upload deployment preparation
Prepare a provider-independent Linux deployment for the existing upload API:
containerized web service, private Redis, host queue service with controlled Docker
access, private R2 settings, verification and rollback instructions. Keep the
analysis sandbox and resource limits unchanged. Let the Cloudflare frontend link
to the configured HTTPS upload service without sharing credentials. No purchase,
DNS changes or live deployment before a host and private bucket are selected.

### T025 — Program and APK uploads
Accept the existing ASAR format plus Windows .exe/.dll and Android .apk files.
Keep upload tokens, SHA verification, private storage, expiry and cleanup intact.
Preserve the file kind in worker staging and partition deduplication by analysis
kind so renaming an artifact cannot bypass parsing through a cache hit. Image
selection remains an operator setting. Verify public fixtures through the real
local HTTP upload flow; hosted uploads still require an analysis backend.

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
The .NET and website phase passed R001; native/Android passed R002, and the T024
worker passed R003. All are merged into main, with the additive schema remaining
0.1.0. See the review handoffs for evidence corrections and provider limitations.

The human: support for more than Electron is required for the final product. REA already has
tools for web bundles/pages, Android (APK), managed code (.NET) and native binaries. First step:
generate real REA fixtures for each target, then a schema proposal (new node kinds / appKind values)
for the other agent to agree before adapter work. Order: websites by URL, APK, .NET, native.

### T022 — MCP connector (essential)
Expose the Ask tools (`packages/ask`) as a remote MCP server so Claude and other clients can query
any analyzed project. Likely a Cloudflare Worker next to the site (needs T018).
