# T006 — Normalize worker output inside the sandbox (codex)

**Branch:** `codex/T006-analysis-worker`
**Status:** partial

## What changed
- T004 became available during this follow-up. Read its handoff/diff and brought
  `claude/T004-adapter` into the worker branch, without editing main. Claimed this
  integration phase separately in `dde4582` before code changes.
- The container now streams capped REA output into its private tmpfs, then calls
  T004's adapter and emits **StudioProject only**. Analysis and normalization
  share Docker CPU/RAM limits and the whole-job deadline. Both the entrypoint
  and REA controller get the validated V8 heap limit. Targets are never executed.
- Added the Node-only `@rea-studio/rea-adapter/file` subpath:
  `adaptReaFile(path, { reaVersion, maxBytes })`. It reads a finalized private file
  with a byte cap, rejects invalid UTF-8/JSON, and returns the existing adapter
  project/report. Raw JSON parsing stays entirely in the adapter package. The
  original pure `toStudioProject` / `adaptReaResult` APIs are unchanged.
- Copied the compiled adapter/schema into the runtime image. Raw temporary data
  is removed after normalization and disappears with the container on failure.
- A bounded worker-owned stderr receipt carries the normalized project id,
  version, and AdapterReport. The host validates it before publishing the capped
  `studio-project.json` file, and still requires successful container removal.
  Missing/wrong-version receipts fail without publishing artifacts.
- T004 review found guessed defaults for unsupported IPC sides/operations and
  endpoint kinds. These now produce visible `analysis-gap` nodes with their
  evidence and are counted in AdapterReport. Unknown channel resolutions or
  literal channels without a name likewise remain gaps. Valid fixture behavior
  is unchanged. Digests must be 64 hexadecimal characters, rather than any string.
- Added real-fixture file-boundary/defensive tests, normalized transport tests,
  missing/invalid receipt checks, and normalized-project checks in the real
  Docker suite. GitHub verification now also runs the adapter tests.
- The Docker installation preparation and locked image/workflow from
  `2026-10-12-T006-codex-container-checks.md` still apply. The setup note outside
  the checkout now reflects the completed adapter integration.

## How to verify
- Passed: `npm test --workspace=@rea-studio/worker` — 31 tests.
- Passed: `npm test --workspace=@rea-studio/rea-adapter` — 27 tests against
  committed fixtures, including the new file boundary and defensive cases. The
  optional uncommitted full-output suite was not run in this follow-up.
- Passed: root `npm run typecheck` and `npm run build`, including Next.js.
- Passed: updated workflow validation with checksum-verified actionlint v1.7.12;
  `git diff --check`. Earlier follow-up verified the runtime lock install and
  reported zero npm audit vulnerabilities.
- Pending: build the Docker image and run the five real tests:
  `npm run test:docker --workspace=@rea-studio/worker`. This checks the configured
  container, actual directory/ASAR analysis, failed input, cancellation, and
  output-limit cleanup. Tests compare normalized ground-truth process/channel
  counts rather than parsing raw REA JSON in worker code.
- Worker CLI: `npm run analyze --workspace=@rea-studio/worker -- <target> <output>`.
  Its descriptor contains `projectPath`, `projectId`, `adapterReport`,
  `reaVersion`, and `elapsedMs`. The file contains StudioProject JSON.

## Not done / known issues
- Real Docker build/execution remains unverified. T006 is therefore not marked
  complete. WSL/Docker installation is prepared, not performed. Enabling WSL
  requires administrator access and may require a restart; no system features
  were changed and no reboot was triggered.
- Setup instructions and the verified installer are at
  `C:\Users\sulai\Downloads\REA for Web\docker-setup\README.md`. The first real
  run can also happen in GitHub Actions after the human pushes this branch.
- The original worker mocks do not exercise the Linux entrypoint; they exercise
  host orchestration using actual adapter conversion of committed fixture bytes.
  Passing them does not prove the container integration works.
- The normalization receipt is bounded to 16 KiB like other stderr lines. If a
  future adapter report exceeds that size, the host fails conservatively rather
  than publishing a result with missing diagnostic metadata.
- Upload SHA-256 and REA subject digest equality for ASAR remains a T007 check;
  do not assume directory digests equal uploaded archive hashes.
- No main merge or push. Queue, global retention, extraction, storage, and orphan
  reaper deployment remain their existing tasks.

## Interface changes or questions for the other agent / human
- No shared StudioProject types or public HTTP API shapes changed. The new
  adapter file subpath is a Node-only worker helper; the demo can keep using the
  unchanged pure adapter entrypoint.
- Worker-local `AnalysisArtifact` replaces `RawAnalysisArtifact`: `projectPath`
  replaces `rawResultPath`, and project id/report are now available. No existing
  web/API caller used the original descriptor. T007 should use normalized output.
- Claude should review the small adapter defensive fixes and file helper along
  with this worker integration. T004's committed fixture conversion passes;
  unsupported values must not be silently promoted to known app facts.
- Claude owns T005 and can continue against the normalized model. This work
  does not modify the web page, shared schema, or heuristic follow-up tasks.
