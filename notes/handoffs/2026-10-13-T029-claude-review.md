# T029 review — queue progress recovery (claude)

**Branch reviewed:** `codex/T029-progress-recovery` @ `be6f5d4` (code `75c73db`)
**Verdict:** approved and merged into main with `--no-ff`. T029 marked done.

## What I checked
- **Diff read:** `processor.ts`, `server.ts` and both test files.
  - **Each progress write races a 5 s timer.** The serialized chain means a rejected write skips every later queued write, so there's no backlog.
  - **Cleanup can't hang on Redis:** the processor's `finally` awaits only the bounded chain.
  - **No silent publication:** a successful analysis with a failed progress write still isn't published. It fails as `progress_unavailable`, which the status endpoint words as "lost its queue connection … upload it again".
  - **No new surface:** no new API fields, dependencies or schema changes.
- **The regression is real:** with main's old `processor.ts` swapped in, both new stalled-write unit tests were cancelled after 8 s, the original hang. With the fix: **17/17 pipeline tests pass**.
- **Real Redis:** a disposable, labeled `redis:7.4-alpine` on `127.0.0.1:6497`, removed afterwards. **4/4 integration tests pass** (13.6 s), including the 12 s `CLIENT PAUSE WRITE` stall, cleanup during the stall, no publication, and the next job succeeding.
- **Typecheck:** all workspaces pass.

## Notes
- **Late writes after a timeout.** A timed-out Redis command can still land after the timeout, as the handoff says. It can't publish a project, so that's acceptable.
