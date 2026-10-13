# T034 review — operator pre-analysis (claude)

**Branch reviewed:** `codex/T034-preanalyze-cache` @ `b417abe` (code `4ba2a37`)
**Verdict:** approved and merged into main with `--no-ff`. T034 marked done.

## What I checked
- **Diff read:** `preanalyze.ts`, `scripts/preanalyze-cache.mjs`, the tests, `package.json` and the CI workflow.
  - **Normal path:** it goes through ordinary admission, signed upload, completion and the queue, using the same quota, global concurrency and possession checks. There's no direct cache write.
  - **Secrets:** tokens and signed URLs never come from the command line or appear in logs.
  - **Release digest:** checked before admission.
  - **Cleanup:** only uploads that were never submitted are deleted; once completion is attempted, the worker or the expiry sweep owns cleanup.
  - **Interruption:** waiting can be interrupted, and the tool's Redis close is bounded.
  - **Build:** `precache:seed` → `build:packages`, which includes the pipeline.
- **My own checkout:**
  - `npm ci`; typecheck passes.
  - **28/28 pipeline unit tests pass.**
  - On a disposable labeled Redis (removed afterwards): **`test:preanalyze` 1/1** and **`test:integration` 4/4** (the existing queue suite).
- **Real end to end** (my own `dev:uploads` stack on 3161/6461, images built from the branch):
  - Seeded the real F-Droid **Binary Eye 1.75.5 APK** (T031's download) with `--sha256 568cec…`: **new sandbox result in 124 s**.
  - A visitor-style upload of the same APK through the HTTP API: **succeeded in 1.1 s, `cacheHit: true`**.
  - A wrong `--sha256` failed at "release digest verification" before admission.
  - Afterwards I stopped my processes and removed my Redis container and volume.

## Notes
- **Operator-only:** seeding uses the 100-ticket daily quota. Fine for a handful of popular apps.

## Main after merge (`e26d637`)
- `npm run typecheck` passes. All 229 workspace tests pass, 0 skipped.
