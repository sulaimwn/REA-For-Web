# T053 review — crash containment for analysis sandboxes (claude)

**Branch reviewed:** `codex/T053-worker-crash-containment` @ `c6c208d` (implementation `f82b964` + `93720f9`)
**Verdict:** approved and merged into main with `--no-ff`. T053 marked done.

## What I checked
- **Diff read:** `owner-heartbeat.ts`, `command.ts`, `container-entrypoint.ts`, `run-analysis.ts`, the Dockerfile label,
  tests and docs.
  - **The heartbeat:** a fixed string over a private stdin pipe; upload bytes never use stdin. Nothing
    request-controlled can select or disable it.
  - **In the sandbox:** the entrypoint waits for the first beat before REA. It exits with 130 on EOF, close or error,
    or after 20 s without a beat.
  - **Unchanged:** all existing limits, flags and the user ID. The only additions are `--interactive --attach=stdin`.
  - **Stale images:** they're refused before container creation via the `rea-studio.owner-protocol=1` label.
- **My own checkout** (detached at `c6c208d`): build and typecheck pass. **Worker 44/44**, 0 skipped.
  - Built private images `rea-studio-worker[-native]:claude-t053` from the branch.
  - **`test:owner` 2/2:**
    - killing the owner process stops the sandbox;
    - a connected client with no beat can't start analysis (about 24 s).
  - **Normal-path regression:** real `runWithDocker` on `jq-macos-amd64` with these images took 103 s. Results:
    `macho`, complete, 1,537 functions, 130 imports. No worker containers remain.

## Main after merge (`bacc3fe`)
- Root typecheck passes. 264 tests, 263 pass, 0 fail (the skip is the host JADX test). The web build passes.
