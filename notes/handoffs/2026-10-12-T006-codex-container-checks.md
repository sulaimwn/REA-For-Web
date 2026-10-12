# T006 — Locked image and real-container verification setup (codex)

**Branch:** `codex/T006-analysis-worker`
**Status:** partial

## What changed
- Continued the existing worker task; resumed its claim in the standalone
  `67de744` commit before implementation. Synced the reviewed T003 schema into
  this branch in `1c2f0ca`; no merge to main or push was performed.
- Reviewed T003's types, mapping table, and handoff. They match the agreed
  fixture-based design. Type checks pass with T003 plus the worker. T004's
  real-fixture conversion tests are still needed to validate the complete model.
- Added `apps/worker/rea-runtime/package-lock.json`, locking REA 6.4.0 and 149
  dependency entries, including registry URLs and integrity hashes. The image
  now uses `npm ci --omit=dev --ignore-scripts`, with its independent runtime
  lock. The workspace does not import or run REA on the host.
- Pinned both Node 24.18.0 image stages to the official Docker Hub tag digest
  `sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`.
- Added `.github/workflows/worker.yml`: read-only permissions, pinned official
  actions, no persisted repository credentials, all-workspace typecheck, worker
  unit tests, image build, real Docker checks, and an orphan-container check.
  Runs on push/pull request or manual dispatch; no image publishing/deployment.
- Expanded the opt-in Docker suite to five tests: actual Docker configuration,
  directory/ASAR static analysis, invalid/oversized input rejection,
  cancellation on progress, and output caps. Failure checks require both
  container removal and discarded partial output. Targets are never executed.
- Prepared the human-requested Docker Desktop installation outside the Git
  checkout at `C:\Users\sulai\Downloads\REA for Web\docker-setup`. Downloaded
  the official installer, verified its valid Docker Inc. Authenticode signature,
  and wrote a setup note. No Windows features, installation, or restart were
  performed. Version: 4.95.0.242831; SHA-256:
  `73431DB38491F770543880366228A23C993F84D1E8E045F56D83B8A98940CF76`.

## How to verify
- Passed: root `npm run typecheck`, including worker source and Docker test types.
- Passed: `npm test --workspace=@rea-studio/worker` — all 29 tests.
- Passed: isolated runtime `npm ci --omit=dev --ignore-scripts --workspaces=false
  --prefix apps/worker/rea-runtime`; 144 packages installed on Windows. Its lock
  also includes optional packages for other platforms.
- Verified: every runtime lock entry has an npm registry URL and integrity hash;
  installed REA and locked REA are both 6.4.0. `npm audit --omit=dev
  --workspaces=false --prefix apps/worker/rea-runtime` reports zero vulnerabilities.
- Validated workflow syntax with checksum-verified actionlint v1.7.12. Shellcheck
  was unavailable on Windows; its optional check was disabled. Reviewed the
  small orphan-check shell step directly. A first checksum command had a parsing
  error; corrected it, verified the archive, and reran validation successfully.
- After installing WSL/Docker or pushing this branch to GitHub, build the image
  and run `npm run test:docker --workspace=@rea-studio/worker`. See worker README.

## Not done / known issues
- T006 remains incomplete: T004 is not yet implemented, and the five real Docker
  tests have not run. CI setup is not evidence of passing container tests. The
  initial handoff's build result applies to the original worker foundation;
  this follow-up reran the relevant typecheck/unit checks.
- Local checks confirmed Windows 11 Home build 26200, about 16 GB RAM,
  virtualization active, and LanmanServer running automatically. WSL is absent.
  Enabling it needs administrator access and may require a restart. The prepared
  setup note uses Microsoft's `wsl --install --no-distribution`, then Docker's
  per-user WSL 2 installation. The user controls installation and restart timing.
- GitHub verification will not run until the workflow is pushed and Actions are
  enabled. No push or dispatch was performed.
- Locked packages and pinned image/actions need intentional future updates.
  No target extraction, upload API, queue, normalized-result storage, or
  deployment/reaper implementation was added; those remain their existing tasks.

## Interface changes or questions for the other agent / human
- No schema or public API changes. T003 files were brought in unchanged.
- Claude can proceed with T004 after the human-approved T003 merge. Do not
  invent a fallback model: convert and test the real fixtures, preserving their
  gaps, evidence, categorical confidence, and distinct recovered-source nodes.
- The existing T003 note about a T001/T002 status conflict is stale. Both rows
  are already `done`; syncing T003 into the current worker branch was conflict-free
  and retained its T008–T010 rows plus Codex's T006 row.
- For the adapter/worker boundary, a bounded file-to-`StudioProject` adapter
  helper would keep raw JSON parsing inside `packages/rea-adapter`. Coordinate
  that helper's signature before integration; the worker currently transports
  only an opaque raw artifact. Do not change shared types unilaterally.
- Cache identity needs a documented check in T004/T007: verify whether REA's
  `subject.digest.sha256` equals the uploaded-file SHA-256 for ASAR input, and keep
  upload and analyzed-directory digests distinct if it does not. Directory-only
  fixtures do not establish that equality.
