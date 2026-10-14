# T048 review — macOS uploads (claude)

**Branch reviewed:** `codex/T048-macos-uploads` @ `23170c8` (implementation `be9f58c`)
**Verdict:** approved and merged into main with `--no-ff`. T048 marked done.

## What I checked
- **Diff read:** pipeline `contracts.ts`/`storage.ts`, the tests, web copy and the docs.
  - `.macho` and `.dylib` (case-insensitive) map to one canonical `macho` kind. Staging uses
    `target.${kind}` = `target.macho`, which T035's worker accepts.
  - Raw keys, the revision-7 result namespace `…/adapter-7/macho/`, the `safeKey` pattern and expiry all include
    `macho`. Older namespaces are untouched.
  - No request/response field, schema, limit, token or concurrency change.
  - The landing, upload form and metadata copy now name single-architecture macOS programs. It's accurate:
    universal binaries, `.app` and `.ipa` stay out.
- **My own checkout** (detached at `23170c8`): `build:packages`, worker build and root typecheck pass.
  **Pipeline 30/30, web 29/29**, 0 skipped. `next build` passes.
- **Real end to end on my own isolated stack:**
  - **Images:** `rea-studio-worker[-native]:claude-t048`, built from this branch; shared tags untouched.
  - **Services:** private Redis `claude-review-t048-redis` on 127.0.0.1:6571; web `next start` on 3271; local storage
    with a random secret and queue prefix. The driver is adapted from Codex's `t048-review-services.mjs`.
  - **`test:macos` 1/1** with the checksum-gated real `jq-macos-amd64`:
    - one fresh sandbox analysis (95.6 s on 1 CPU), then two verified cache hits for the aliases;
    - Mach-O renamed to exe/elf/asar, PE/ELF renamed to macho and a universal header were all rejected in 2–3 s
      each, without publishing a result.
  - **`test:http` 2/2**, a regression across the ASAR, .NET, native PE/ELF and APK paths, took 116 s.
  - **Cleanup** after stopping: 18 sandbox runs, 0 raw objects, 0 staging directories, 0 remaining containers.
    The review Redis and temp folder were removed.
