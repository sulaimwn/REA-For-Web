# T042 review — upload API Redis deadlines (claude)

**Branch reviewed:** `codex/T042-redis-api-deadlines` @ `10c9144`
**Verdict:** approved and merged into main with `--no-ff`. T042 marked done.

## What I checked
- **Diff read:** `server.ts`, both integration tests, `package.json`, the CI step and the hosted-uploads doc.
  - **Deadline scope:** the 5 s `commandTimeout` is only on web-side connections (the `UploadControl` client
    and the BullMQ producer `Queue`). Neither issues blocking commands: there is no `QueueEvents`,
    `waitUntilFinished`, `subscribe`, `BRPOP` or `XREAD` in `packages/pipeline/src` or `apps/web/lib`, so the
    deadline can't cut off a legitimate long wait. Worker connections are unchanged.
  - **`enableOfflineQueue: false` on the producer** fails fast instead of queueing commands while
    disconnected. That's BullMQ's recommended producer setting, and `test:http` (Codex) covers the real queue.
  - **Quota Lua:** `INCR`, then `EXPIRE` only if `TTL < 0`, in one atomic script. A write that times out but
    still lands can't leave an immortal key, and it self-heals any old key without a TTL. The limit is still 100/day.
  - **Errors stay sanitized:** a timeout surfaces through the existing 503 path, with no Redis detail in responses.
- **The tests check the right things:** the admission test asserts no upload record or ticket and a positive TTL
  on the quota key after a paused-write admission. The completion test keeps raw bytes, rejects a wrong token,
  and on retry produces exactly one queued job with global concurrency 1.
- **My own checkout** (detached at `10c9144`, on my own disposable Redis `claude-review-t042-redis` on
  127.0.0.1:6479, removed afterwards; the existing `rea-studio-upload-redis-6390` was not touched):
  - `build:packages` and the root `npm run typecheck` pass.
  - **Pipeline unit tests 28/28, `test:integration` 4/4, `test:redis-api` 4/4. 0 skipped, run sequentially.**
    The stalled-read, timed-out-admission and queue-write subtests took 12.1 s, 5.0 s and 5.1 s.

## Main after merge (`2d1ca69`)
- Root `npm run typecheck` passes. `npm test --workspaces --if-present`: 248 tests, 247 pass, 0 fail. The one skip is
  the host JADX test (`REA_JADX_MCP_JAR` unset). The web production build passes.
