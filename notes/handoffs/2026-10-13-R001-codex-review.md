# R001 — Overnight integration review (codex)

**Branch:** `codex/T008-T022-review`
**Status:** approved for merge. Main checks are recorded below after integration.

## Reviewed scope and schema agreement

Reviewed Claude's combined `claude/T008-T022-integration` at `c372387` (code at
`6489170`), containing T008, T012, the initial T021 .NET/web phase, and T022.
I agree to the fixture-backed .NET/web schema additions and keeping version
0.1.0. Existing Electron files remain supported; endpoint assessments are
optional. For websites, `target.sha256` is the capture evidence identity, not
a claim that a URL has one file digest.

## Changes made during review

- Recovery preserves REA's unresolved relative import and adds a separate,
  labeled Studio path inference. Paths cannot climb out of the app. Isolated
  runs with remaining relationship warnings do not clear the original warning.
  Repeated recovery is fully idempotent, including metadata. Original IPC
  summary/pairing is preserved and explicitly described as pre-recovery.
- Public HTTP MCP reads trusted static assets or local public files, never a
  URL derived from caller Host. Requests are capped at 64 KiB before JSON
  parsing; opaque/malformed Origin values are rejected. Stateless JSON transport
  returns 405 for persistent SSE/session methods and closes the server.
- Local MCP rejects incomplete exports before accepting queries and generates
  collision-free ids even for names like `Same`, `Same`, `Same-2`. Its test
  script builds the actual stdio binary that subprocess tests exercise.
- Chrome startup/early exit is handled promptly; shutdown cannot hang waiting
  for an exit event already delivered. CDP requests have deadlines. Extraction
  JSON is bounded, and cleanup accepts only REA-named folders directly under
  the system temp directory.
- Compiler-style type names are explicitly labeled as Studio heuristics in
  findings, Inspector and Ask. Web evidence keeps REA's actual authority. Ask
  paths cannot connect unrelated .NET methods through the shared assembly root.
  Program files remain static; website capture really loads the page in a fresh
  browser, and UI/MCP/docs now say so.
- Worker Docker build includes the new MCP workspace manifest. Result cache
  revision is `adapter-6`; keys from revisions 2–5 remain readable for saved jobs.
  Docs distinguish local support from the Electron-only hosted worker.

## Verification before merge

- Production website build passes on Windows. Eight workspace typechecks and
  the complete suite pass in the clean Linux/Cloudflare build: 163 tests, 162
  pass and one real-browser capture test skipped because Chrome is absent there.
  Windows CLI tests include that real Chrome capture and pass.
- Seven real Docker tests pass with a separate `integration-review` image:
  sandbox flags, directory and ASAR normalization, name preservation, retained
  partial timeout evidence, invalid input, cancellation and output caps. Only
  the ignored compiled test image constant was temporarily changed, then
  restored; Claude's shared image tags were untouched.
- Official SDK client exercised six tools and five projects on the local
  production server and Cloudflare runtime: .NET/web overviews, endpoint
  evidence, uncached demo loading with an untrusted Host, 413 input limits,
  403 invalid Origin, and 405 persistent SSE. No paid model call was made.
- Browser verified .NET P/Invoke evidence (library/export/calling convention),
  website frameworks and scripts, and GitHub Desktop's two visible plausible
  endpoints with all 87 unlikely candidates still available through the toggle.
- Did not repeat Claude's full 11-minute GitHub Desktop recovery benchmark.
  Recovery regressions use the committed real isolated-file fixtures.

## Remaining work and coordination

- T008 recovery is local CLI functionality; wire bounded recovery into the
  worker separately. Original IPC summary does not re-correlate recovered IPC.
- Hosted uploads still require a configured Docker host, object storage and
  queue; a Cloudflare website deploy alone does not start the analyzer.
- T021 native/Android work after `26d2c48` is not in this integration. Claude
  has also completed stacked `claude/T024-native-worker` (`662d513`) for review.
  Review/sync those against the new main separately, preserving these recovery,
  evidence, browser and MCP fixes. T021 remains review for that continuation.
  The human has already approved JADX/Ghidra; do not ask again.
- Claude owns T024. Codex's next worker step is independent review of T021's
  native collector/schema and T024's sandbox/image changes. Program uploads
  must subsequently be added to the pipeline; website capture needs its own
  restricted-egress design, keeping program analysis network-disabled.
- Public HTTP MCP exposes demos only. Private uploaded projects are not
  published through it; local stdio accepts the user's own exports.
- The existing live site responds. These new features reach it after the
  human pushes main; no push or deployment was performed by Codex.

## Main verification

Pending the required full checks immediately after the merge.
