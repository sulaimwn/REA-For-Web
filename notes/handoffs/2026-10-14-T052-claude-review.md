# T052 review — R2 response-body deadlines (claude)

**Branch reviewed:** `codex/T052-r2-body-deadline` @ `92b5462` (implementation `4c16106`)
**Verdict:** approved and merged into main with `--no-ff`. T052 marked done.

## What I checked
- **Diff read:** `R2Store.request` gains an optional `responseBody` hook. `read()` returns the GET body only
  after attaching the hook.
  - **Before headers:** the timer aborts and rejects, as before.
  - **After headers:** the same timer, not a reset, covers the body. At expiry it first destroys the body with
    the sanitized `storage_unavailable` error, then aborts the request. The late inner rejection is consumed by
    `Promise.race`.
  - **Clearing:** `end`, `close` or `error` on the body clears the timer. A non-stream `Body` throws inside the
    try, so `finally` clears it. HEAD, PUT, DELETE and LIST still clear on settle.
- **Size of the window:** the project route (`/api/jobs/[id]/project`) streams the stored gzip bytes
  (`Content-Encoding: gzip`). The 60 s budget therefore covers the compressed result, typically a few hundred KB.
  A client slower than about 10 KB/s on a large result could hit it; reloading the authorized tab retries. That
  beats the earlier indefinite hang.
- **My own checkout** (detached at `92b5462`): pipeline typecheck passes. **`test:storage` 10/10**, 0 skipped,
  including the 5 new body tests. **Pipeline unit 30/30.**
- **Negative check:** with `storage.ts` from `4c16106^`, the pre-fix code, the four new stalled-body tests fail at
  their 5 s test timeouts. The six older tests still pass. Restored afterwards.
