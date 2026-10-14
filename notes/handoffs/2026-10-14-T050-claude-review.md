# T050 review — Linux queue identity (claude)

**Branch reviewed:** `codex/T050-linux-worker-identity` @ `7922cc2`
**Verdict:** approved and merged into main with `--no-ff`. T050 marked done.

## What I checked
- **Diff read:** `limits.ts`, `queue.ts`, `run-analysis.ts`, `deploy/linux/check-worker.mjs`, the systemd unit, docs,
  CI and `scripts/check-linux-worker-identity.mjs`.
  - `WORKER_USER = "1000:1000"` only names the existing sandbox user. The container argument still resolves to
    `--user=1000:1000`.
  - `assertQueueIdentity()` checks the effective UID, on Linux only. Dev hosts on Windows or macOS with Docker
    Desktop are unaffected.
  - The queue CLI calls it before any config or connections, and so does the hosted preflight.
  - Nothing request-controlled can choose a user. Sandbox flags, limits, upload modes and tokens are unchanged.
- **CI safety:** GitHub's Linux runner user is UID 1001, but no CI step starts `apps/worker/dist/queue.js`.
  `test:hosted` and `dev:uploads` aren't in the workflows. The new `test:worker-identity` sets UIDs inside
  containers, so it doesn't depend on the runner's UID.
- **Docs:** the account recipe creates `rea-worker` with UID 1000 only if it's free. Otherwise use the existing
  UID-1000 account on the dedicated host, or stop. No duplicate UIDs or renumbering.
- **The test:** its assertions would fail if the guard accepted UID 1001 (`identityAccepted === false`), or if
  the mismatched inode were readable by the sandbox UID (`EACCES` expected). It removes only containers and
  volumes carrying its unique label.
- **My own checkout** (detached at `7922cc2`): worker build and typecheck pass. **Worker 39/39**, 0 skipped.
  **`npm run test:worker-identity` passes** on Docker Desktop's Linux engine; no labeled volumes remain afterwards.

## Note
- A Linux developer whose login UID isn't 1000 now gets a clear startup error from `dev:uploads`. Before, they
  got failed jobs. That's the correct outcome; it could be mentioned in `docs/uploads.md` later.

## Main after the T048 and T050 merges (`cd9c383`)
- Root typecheck passes. `npm test --workspaces --if-present`: 259 tests, 258 pass, 0 fail. The skip is the host JADX test.
  The web production build passes.
