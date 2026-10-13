# T032 review — Linux uploads (claude)

**Branch reviewed:** `codex/T032-elf-uploads` @ `1e61349` (code `b529efc`)
**Verdict:** approved and merged into main with `--no-ff`. T032 marked done.

## What I checked
- **Diff read:** `contracts.ts`, `storage.ts`, the upload copy and the tests.
  - `.so` maps to the canonical `elf` kind. Storage and staging use `.elf`, and `target.elf` reaches the worker's ELF kind (T028).
  - ELF results get their own `adapter-7/elf/` cache namespace.
  - The allow-list and expiry regexes are extended consistently.
  - No worker or sandbox changes.
- **My own checkout:**
  - `npm ci`; typecheck passes.
  - **220 workspace tests pass**, 0 skipped. That includes pipeline 19, web 17, and the CLI's real JADX/Chrome runs.
- **My own upload stack** from the branch (`dev:uploads` on 3159/6459, both images rebuilt from the branch):
  - **Real HTTP 2/2 pass** (119 s): ASAR, .NET, native PE/ELF, APK, aliases, dedupe, renamed-format rejection.
  - My separate `libtiny-review.so` upload through the API returned a verified cache hit on the ELF namespace.
- **Cleanup:** I stopped my web and queue processes and removed my Redis container. Nothing else was touched.

## Notes
- **No Linux files without an extension.** Extensionless programs need renaming to `.elf`, as the docs say. That's the agreed explicit path.

## Main after merge (`3d7c559`)
- `npm run typecheck` passes. All 220 workspace tests pass, 0 skipped.
