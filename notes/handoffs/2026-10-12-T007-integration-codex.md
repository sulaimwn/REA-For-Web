# T007 — Reviewed explorer integration and upload progress (codex)

**Branch:** `codex/T007-upload-pipeline`
**Status:** review

## What changed

- Integrated main's reviewed T009/T013/T014/T016/T017 aggregate (`c9ea1a7`)
  and T019 redesign (`f9f2224`).
  Uploaded projects now use the same explorer, evidence, and Ask panel as demos
  and local files. All seven workspaces are present in the regenerated lockfile.
- Upload, analysis and retry controls now use T019's typography, theme tokens,
  buttons and site chrome. The homepage offers uploads when the running service
  is configured. Homepage/upload routes read that configuration per request;
  an unconfigured upload page points to local analysis instead of a dead form.
- Fixed the dynamic homepage's root-directory startup failure: demo metadata is
  imported into the server build rather than read relative to process.cwd().
  Web pretypecheck generates the manifest, as prebuild already does. Each loader
  call returns its own array so sorting does not mutate the shared manifest.
- The final lockfile comparison against `6473221` contains only the two pinned
  font package additions: no existing dependency version changed or disappeared.
- File preparation and transfer have distinct progress bars. Transfer bytes are
  actual XMLHttpRequest events, and completion waits for a successful server
  response. Cancellation and unmount clean up the request. Queue/analysis stages
  show REA progress without inventing an analysis percentage.
- Fixed a real HTTP failure found during verification: a cached job could complete
  between reading its hash and its state, leaving a stale empty result receipt.
  Terminal status reloads the job snapshot; project retrieval does the same if
  necessary. Regression tests cover success and timeout transitions.
- Shared caches use `target.asar` as their fallback target name. The authorized
  status response supplies the job's own filename; the viewer uses that label
  only when there is no root package.json. REA package facts and stored cache
  objects remain unchanged. Cache revision is now 5; authorized revisions 2–4
  remain readable. This also incorporates the T009 normalization changes.

## How to verify

- All seven workspace typechecks and the production build pass.
- 115 tests pass across the current sources: web 9, worker 33, CLI 8, adapter 40,
  pipeline 11, Ask 14. Ask tests use scripted responses, with no paid API calls.
  Following the T019 integration, all seven typechecks, the nine web tests and
  the root production build were checked again. Main itself passed its full
  six-workspace checks, 94 tests and production build after the T019 merge.
- Real Docker checks: 7 pass. Real Redis checks: 3 pass. Real HTTP check: 1 pass
  after the cache-completion race fix, covering fresh analysis, a cached duplicate,
  access/origin/hash rejection, idempotent completion and malformed archives.
- Browser upload of the public `review-tiny.asar` reaches the integrated explorer:
  28 nodes, 58 links, complete coverage; no console errors.
- Following the redesign, another browser upload reaches job
  `8b31f7c3-a810-423d-8538-15c348631999` with the same complete 28/58 map.
- A temporary unconfigured server started from the repository root shows all
  three demos and the local-analysis fallback, without an upload form or dead
  homepage upload link. The configured preview shows upload navigation and the
  live demo. Final seven-workspace typechecks, nine web tests and build pass.
- The integrated IAB tab actually rendered at 375px content width. Its homepage
  has equal clientWidth/scrollWidth; selecting the tiny demo's main process
  exposes its evidence, and Ask remains reachable below the graph. This completes
  the narrow-layout check that was unavailable in the separate review tab.
- Existing Obsidian job `0f28b173-a951-4ae9-9a58-6a6842b56b33` remains readable:
  `obsidian.asar`, Electron, 232 nodes, 337 links, partial coverage, 34 gaps and
  three files with lost relationships. Its Ask tab opens without console errors.
  This checks compatibility without repeating the eight-minute analysis.
- Screenshots outside Git: `rea-studio-updates-verified.png` shows the redesigned
  tiny demo with observed IPC evidence; `obsidian-redesign-verified.png` shows
  the preserved Obsidian map. Both are under
  `C:\Users\sulai\Downloads\REA for Web`.
- Local web/queue preview is running at `http://localhost:3104`. Redis remains
  persistent on localhost:6380. Existing private job tokens and stored results
  were preserved. The separate review preview on 3105 has been stopped.

## Not done / known issues

- T007 still needs Claude's cross-review before merge into main. Nothing pushed.
- No live R2 connection or hosted upload deployment. No paid Ask requests or
  generated tour recordings; generator/viewer infrastructure is available.
- T019 is reviewed and merged into main, including a correction keeping evidence
  and Ask reachable in the narrow embedded layout, now verified in the integrated
  browser at 375px. T018's static Cloudflare setup does
  not yet connect T007's Redis and trusted Docker host.

## Interface changes or questions for the other agent / human

- Claude: review this branch, then merge using the existing agent workflow. Keep
  T007 as review until cross-review passes; the human need not approve merges.
- Optional `JobStatus.uploadName` is an additive upload-API change documented in
  `ARCHITECTURE.md` and `docs/uploads.md`, awaiting your review. It is not a new
  StudioProject schema field. Shared caches must not reuse an uploader's label.
- T018: T007 uses no Next 16.4-specific feature, so the 16.3.8 pin is acceptable
  in principle. I have not independently validated the OpenNext runtime on that
  version. Recheck after integrating the upload routes; static demo deployment
  and a hosted upload backend are separate milestones.
- T019: your redesign is now reviewed, merged and integrated here. Upload UI
  changes include functional progress/stage controls, the new theme, navigation
  and a friendly unconfigured state. No need to overlap worker/storage code.
