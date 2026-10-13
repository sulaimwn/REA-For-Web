# T007 — Upload pipeline cross-review (claude)

**Branch reviewed:** `codex/T007-upload-pipeline` @ `ab3a99b` (merged via `claude/T007-review`)
**Status:** approved and merged into `main`

## What I checked
- Read the security boundary end to end:
  - `packages/pipeline/src/{contracts,server,storage,processor}.ts`
  - the five `apps/web/app/api/**` routes, `lib/uploads-server.ts`, `UploadForm.tsx`
  - the worker diff (`limits`, `container-entrypoint`, `run-analysis`, `queue`) and the adapter's timeout path
- Upload control:
  - Origin is checked on every mutation; R2 mode requires the access key, compared in constant time.
  - Request JSON is capped at 4 KiB.
  - Job tokens are 32 random bytes; Redis stores only their SHA-256 and compares in constant time.
  - Job ids are UUID-validated before any Redis key or storage key is built.
  - Errors are sanitized: non-pipeline errors become a generic 503.
- Storage:
  - Keys are allowlisted by regex, so there is no path traversal.
  - The local HMAC signature binds id, size, SHA-256 and expiry.
  - Writes are atomic (`wx` + rename), and bytes are hashed while streaming.
  - R2 presigns content-length. The worker re-verifies size and SHA-256 before analysis **and before any cache reuse**, so possession of a hash is proven.
- Processor and worker:
  - The uploader's filename never enters the shared cache.
  - Failure messages are reduced to `Analysis failed (<code>)`.
  - Raw upload and staging are removed in `finally`.
  - The container keeps `--network=none`, non-root, read-only and cap-drop.
  - `targetName` is validated on both sides of the container boundary.
  - Timeout publication requires REA's own `provider_timeout` with retained Evidence, explicitly `partial` coverage and complete cleanup. It is backed by a real REA 6.4.0 fixture.
- Browser: the SHA-256 is computed incrementally in 4 MiB slices (no whole-file buffer). The XHR progress bar uses real upload events.

## Checks rerun (Windows, review worktree)
- `npm ci --ignore-scripts`, then `npm run typecheck`: all seven workspaces pass.
- `npm test --workspaces`: **115 pass** (web 9, worker 33, cli 8, adapter 40, pipeline 11, ask 14).
- Rebuilt `rea-studio-worker:rea-6.4.0` from this commit, then ran `test:docker`: **7/7 pass**.
- Redis `test:integration` against localhost:6380 (random per-test prefixes): **3/3 pass**.
- `test:http` against the running upload preview on :3104: **1/1 pass** (fresh analysis, dedupe, auth/origin/hash rejection, malformed archive).

## Non-blocking notes (follow-ups, not required for merge)
1. `server.ts` admission budget: `INCR` and `EXPIRE` are two calls. If the process dies between them, that day's counter key never expires.
   - It's harmless for correctness because the key is per-day, but a `MULTI`/Lua or `SET … NX EX` + `INCR` would be tidier.
2. `JobStatus.uploadName` (an additive API field): approved. It's correctly kept out of the shared cache.
3. The hosted-upload gap stays open: R2 bucket, hosted Redis, and a long-running Docker host for `npm run queue -w @rea-studio/worker`. On Cloudflare without those env vars, `/upload` shows the local-analysis fallback and the API returns 503, as Codex verified.
