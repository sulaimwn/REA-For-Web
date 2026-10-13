# T007 — Cloudflare pin compatibility and restored upload preview (codex)

**Branch:** `codex/T007-upload-pipeline` @ `b370956` plus this handoff.
**Status:** review; Claude's cross-review is still required before merging T007.

## What changed

- Merged reviewed main @ `ed39599`: T023 branding and T018 Cloudflare setup.
  Main itself passes all six workspace typechecks, all 94 tests and its build
  after the T018 merge. T018's independent review lives on main.
- Resolved only the dependency-lock conflict. Kept main's verified Cloudflare
  lock, added the existing pipeline dependencies, and preserved all seven
  workspaces, scripts and feature code. Both site and adapter resolve Next
  `16.3.8`. The pipeline still resolves its exact S3 SDK `3.1150.0`; OpenNext's
  separately pinned AWS adapter has its own older SDK copy.
- Corrected the OpenNext cache comment: the demos use static assets, while
  homepage and upload/job routes render dynamically without ISR. Adding SSR
  does not itself require a writable incremental cache. Backend hosting remains
  separate work.

## Verification

- Windows: all seven typechecks, all 115 tests (web 9, worker 33, CLI 8,
  adapter 40, pipeline 11, Ask 14) and the root production build pass on Next
  `16.3.8`.
- Analysis Docker image rebuild passes. Its runtime manifest is unchanged:
  `a5eaaabec6bb0aa3fa9f8feb899db45a508dac219804b6d766fd1688c29970f1`.
- Real Redis integration: all three checks pass using isolated test namespaces.
- Real HTTP integration: fresh public-fixture upload through the current Next
  API, queue and Docker analyzer succeeds; result authentication, dedupe and
  rejection paths pass. No target is executed.
- Saved Obsidian job `0f28b173-a951-4ae9-9a58-6a6842b56b33` reloads in the
  browser with its existing token: `obsidian.asar`, 232 nodes, 337 links,
  partial coverage, 34 gaps and three files with lost relationships. No repeat
  analysis needed. No private job token printed or changed.
- Clean Linux rehearsal on the pinned Node image with `procps`: install without
  package scripts, all seven typechecks, all 115 tests and the OpenNext build
  pass. Wrangler local deployment dry run passes: 36 assets, 9194.84 KiB
  uncompressed / 1887.37 KiB gzip.
- Local workerd without upload credentials: dynamic `/` has all demos; `/open`,
  demo and JSON routes return 200. `/upload` visibly offers local analysis,
  without a file form. POST `/api/uploads` returns the intended 503. This checks
  that T007 can merge without breaking the already-prepared static launch.

## Not done / known issues

- Nothing pushed or deployed. No R2 account connection, remote Redis or trusted
  hosted Docker runner configured; this is not a hosted-upload acceptance test.
- No paid Ask call, API key, generated tour recording or new account secret.
- Claude still needs to review T007, including the previously documented
  optional `JobStatus.uploadName` field and retained partial timeout results.

## Handoff

- Your local upload website and queue are running at `http://localhost:3104`
  on Next `16.3.8`; Redis stays on port 6380 with its existing persistent data.
  Private results and the existing local signing secret were preserved.
- Temporary Cloudflare previews on ports 3107/3108 are removed after review.
- Claude: review this branch against current main, rerun its checks and merge
  after approval under AGENTS.md. No need for the human to approve the merge.
  Main's Cloudflare deployment is already approved; keep the hosted-backend gap
  explicit when you review or deploy T007.
