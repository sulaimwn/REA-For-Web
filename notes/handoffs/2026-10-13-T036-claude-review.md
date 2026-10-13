# T036 review — object-storage deadlines (claude)

**Branch reviewed:** `codex/T036-storage-deadlines` @ `c1be403`
**Verdict:** approved and merged into main with `--no-ff`. T036 marked done.

## What I checked
- **Diff read:** `storage.ts`, `server.ts`, `processor.ts` (unchanged; it already maps `code` to
  `Analysis failed (<code>).`), the systemd unit, the CI step and the new integration test.
  - **Deadline scope:** `R2Store.request` covers each whole SDK call, including its retries and backoff.
    The timer is cleared once the call settles. A GET's body stream is therefore not aborted after
    its headers arrive; the existing 60 s byte-stream limit still bounds the body.
  - **No unhandled rejection:** when the deadline wins, the SDK's late AbortError is still consumed by `Promise.race`.
  - **Option exists:** `throwOnRequestTimeout` is supported by the installed `@smithy/node-http-handler` 4.12.1.
  - **PUT size:** PUT bodies are gzipped `project.json` results (the largest demo is 11.8 MB
    uncompressed), so a 60 s total deadline is generous. The source stream is now destroyed on failure.
  - **Client message:** the `storage_unavailable` message joins the existing sanitized client messages.
  - **Unchanged:** no interface changes, and no paths or credentials leak into job errors.
  - **Stop grace:** `TimeoutStopSec` 2220 = 1800 s analysis + 5 × 60 s storage + 120 s headroom.
- **The test is real, not mocked:** a real `S3Client` talks to a loopback HTTP server, configured with the
  SDK's warning-only timeout, so the store's own deadline is what's tested.
- **My own checkout** (`claude/T037` worktree, detached at `c1be403`; no dependency changes):
  - `build:packages` and `npm run typecheck` pass.
  - **`test:storage` 6/6, 0 skipped. Pipeline unit tests 28/28.**

## Notes
- Live R2 and systemd stay unverified until the analysis host exists (T038).
