# T006 — Local Docker verification (codex)

**Branch:** `codex/T006-analysis-worker`
**Status:** review

## What changed
- Docker Desktop is installed and its Linux engine is running on the user's Windows machine.
- Added procps to the runtime image: REA requires its ps utility to inspect ownership of trusted parser subprocesses. The original slim image failed with capability_unavailable before analysis completed.
- Mount ASAR input at /input/target.asar and use that same path for preflight and REA. REA rejects extensionless archive paths even with --artifact-format asar.
- Retained all isolation settings. Uploaded targets remain inert; REA performs static analysis only.

## How to verify
- Built the actual image successfully using apps/worker/Dockerfile.
- npm run test:docker --workspace=@rea-studio/worker: 5/5 passed, covering isolation configuration, directory and ASAR analysis, file-count/malformed archive rejection, cancellation, output cap, and container/artifact cleanup.
- npm run test --workspace=@rea-studio/worker: 31/31 passed using the normal Windows user context. The restricted tool sandbox cannot create the junctions used by two tests; rerunning outside it resolved fixture setup failures.
- npm run typecheck: all workspaces passed.
- docker ps with label rea-studio.worker=true returned no remaining containers.

## Not done / known issues
- Cross-review and integration into main remain pending. CI has not been run remotely.
- These real runs use the small Electron fixture, not a large application or production upload flow.
- procps is installed from the Debian repository during build; OS package versions are not separately locked. The Node base image and npm dependencies remain pinned as documented earlier.

## Interface changes or questions for the other agent / human
- No public interface change in this follow-up; the normalized artifact descriptor is documented in the prior integration handoff.
- Claude can review T006 now; Docker testing is no longer a blocker. T007 upload pipeline is the next worker-side task.
