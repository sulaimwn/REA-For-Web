# T025 review — program and APK uploads (claude)

**Branch reviewed:** `codex/T025-program-uploads` @ `1a60da6` (code `f373981`)
**Verdict:** approved and merged into main with `--no-ff`. T025 marked done.

## What I checked
- **Diff read in full:** `contracts.ts`, `processor.ts`, `server.ts`, `storage.ts`, `UploadForm.tsx`, `upload-project.ts`, `dev-uploads.mjs`. Notes:
  - Browser and server admit uploads through one shared `uploadKind()` list.
  - Request objects are rebuilt from validated fields (unknown fields dropped).
  - Job data is re-validated in `processUpload` before use.
  - Storage keys stay allow-listed, including for R2 signing (`safeKey`).
  - The cache key is partitioned by kind (revision 7). Old ASAR revisions 2–6 stay readable.
  - The worker gets a canonical `target.<kind>` name and never the uploader's filename.
  - `projectForUpload` keeps adapter-derived names (assembly; Android package when not a fallback) and applies the authorized upload name otherwise. I traced this against the native and Android adapters' fallbacks.
- **My own checkout:**
  - `npm ci`; `npm run typecheck` passes.
  - All **204 workspace tests pass**, 0 skipped (adapter 100, worker 37, CLI 16 with real JADX/Chrome, web 14, pipeline 14, ask 16, mcp 7).
- **My own upload stack** from the branch (`dev:uploads` on ports 3158/6458, native image enabled):
  - Redis integration 3/3 and real HTTP integration 2/2 (128 s, real .NET, Ghidra and JADX runs).
  - Re-uploading the tiny `.exe` and `.apk` through the API returned instant cache hits after possession was verified.

## Findings
- **No blocking issues.** One note for later: `dev:uploads` now builds the 2.2 GB native image by default, so the first local start takes several minutes. That's already in the handoff and docs.

## Upload timing (for the speed work)
- Measured on main with Obsidian's real 27 MB `obsidian.asar`:
  - hash + ticket + transfer under 1 s;
  - queue wait 0.01 s;
  - **analysis 458 s** in the 1-CPU sandbox.
- The same analysis on the 8-core host without the sandbox took **774 s** (CLI, `--no-recover`). So REA's sequential per-file parsing is the bottleneck, not CPU limits.
- A few big bundled files dominate: Obsidian's `app.js` (~60 s), Mermaid, PDF.js, CodeMirror.
- Most promising next steps:
  - pre-analyzing popular apps;
  - a lower per-file analysis cap (`sourceTimeoutMs`) for vendored libraries, measured against lost detail.

## Main after merge (`cbce4df`)
- `npm run typecheck` passes. All 204 workspace tests pass, 0 skipped.
- Note: `npm ci` in the main checkout hit EPERM because a `next start` on port 3110 (not mine, started 08:04) holds Next's native module. I repaired `node_modules` with `npm install --ignore-scripts`; the lockfile is unchanged. Run future main checks in a separate worktree, or stop that server first.
