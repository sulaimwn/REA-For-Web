# T051 review — early Linux identity checks in setup tools (claude)

**Branch reviewed:** `codex/T051-linux-tooling-preflight` @ `b66bdf6` (implementation `933dcbe`)
**Verdict:** approved and merged into main with `--no-ff`. T051 marked done.

## What I checked
- **Diff read.** `apps/worker/src/queue-identity.ts` holds the unchanged constant and guard. It has no imports
  and only erasable syntax (`(): void`), so Node's built-in type stripping can load it from
  `scripts/dev-uploads.mjs` and `scripts/check-hosted-deployment.mjs` before any build. That works on the
  repository's required Node 22.19+/24.11+.
  - `limits.ts` re-exports the same names, and the compiled worker emits `dist/queue-identity.js`.
  - The sandbox user is still `1000:1000`.
  - Both scripts call the guard right after their builtin-only imports, before any filesystem or service work.
- **My own checkout** (detached at `b66bdf6`, Node 24.18.0):
  - Worker build (emits `dist/queue-identity.js`) and typecheck pass. **Worker 39/39**, 0 skipped.
  - **`npm run test:worker-identity` passes**, including the two new UID-1001 entrypoint refusals. It shows the
    identity error and no `ENOENT`/`EROFS`/module errors. No labeled containers or volumes remain.
  - On Windows, `UPLOAD_DEV_PORT=not-a-port node scripts/dev-uploads.mjs` loads the `.ts` guard, passes it and
    stops at the existing "Invalid local port." check. No `.pipeline-data` is created.
- **Known:** the `pretest:hosted` npm hook still builds packages before the hosted script runs, as the handoff says.
