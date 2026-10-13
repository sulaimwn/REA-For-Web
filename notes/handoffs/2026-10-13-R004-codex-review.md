# R004 — Linux ELF review and corrections (codex)

**Branch:** `codex/R004-linux-review`
**Reviewed:** `claude/T028-linux-elf` at `e26517c`
**Corrections:** `3129a3b`
**Status:** review of Codex's small corrections requested before merge. T028's ELF implementation otherwise passes independent review.

## Findings and corrections
- The new format map guessed `pe` for missing/unknown REA metadata and could return inherited object properties for strings such as `constructor` or `__proto__`. A regression against the original implementation failed. The adapter now accepts only the recorded `pe`/`elf` formats established by real fixtures and rejects malformed or unsupported metadata. No format guesses or unsupported Mach-O route.
- Verified that the ELF fixture's digest exactly matches the committed binary bytes. This is an actual ELF fixture, not a renamed PE.
- Narrowed the library explanation in the adapter, inspector and docs to what the collected evidence proves: these import results name symbols without identifying providing libraries. Avoid a general claim that ELF files cannot record dependency information. Call edges remain observed; URL/storage uses and entry-name patterns retain R002's heuristic limitations.
- Reviewed read-only mounting, ELF header/byte/file caps, native-image selection and shared native PE collector path. Program files are never executed; sandbox restrictions are unchanged.

## Verification
- All eight workspaces typecheck. Workspace suites pass: **213 tests passed, one optional host-JADX CLI test skipped** because that process had no provider configured. The actual Docker/JADX Android test below passed, so this is a host CLI check limitation, not an Android worker failure.
- **106 adapter tests pass** after the final wording corrections, including recorded ELF calls, imports, entry-name handling, fixture digest and rejection of unknown/prototype-property formats. The full workspace run preceded the wording-only correction; the affected suite was rerun afterward.
- Built separate `rea-studio-worker:r004` and `rea-studio-worker-native:r004` images from the final code. **12/12 actual Docker tests pass with zero skips**, including standard-image .NET, native PE, ELF, APK, retained partial Evidence, malformed inputs, output limits, cancellation and container cleanup. ELF analysis/refusal took about 39 s. The existing production/test tags were untouched.
- The unchanged Docker integration assertions were routed to those separate image names using the existing `runWithDocker` injection seam. The small driver is in the shared parent, `R004-route-review-images.mjs`; logs are `R004-docker-tests.log`, `R004-standard-image.log` and `R004-native-image.log`. Generated test files are ignored build output. Temporary R004 image tags were removed after all their containers were cleaned.
- Root production build passes. The initial sandboxed build was blocked by Windows junction permissions; the user-environment build succeeded. Regenerated package output/demo data before the final build so the browser saw the corrected findings text.
- Browser verified `/explore/tiny-linux`: **33 nodes / 39 links**, the `sync_notes` neighborhood, actual call evidence, visible URL-use heuristic, and an import inspector saying the providing library was not recorded. Zero console warnings/errors. Screenshot: shared parent `R004-linux-demo.png`.
- `git diff --check` passes. No push, purchase, production deployment or credentials.

## Interface agreement and next work
- Agree to the proposed additive `TargetInfo.format = 'elf'`: the real fixture establishes it and consumers typecheck. The proposed `macho` enum member is only a reservation; there is no accepted adapter/worker route or fixture for it. Do not claim macOS support from the enum.
- **Proposed next upload integration:** accept explicit `.elf` and `.so`, both mapped to the canonical `elf` analysis kind, with existing SHA possession verification and a separate ELF cache path. Keep PE/ASAR/APK parsing isolated; the worker must still verify ELF bytes. Do not add arbitrary extensionless/public URL admission in that task. CLI header detection remains available, and extensionless programs can be renamed to `.elf` for the explicit upload path once implemented.
- The public upload API currently still accepts only `.asar/.exe/.dll/.apk`. ELF is tested through the worker and demo, not a public upload feature yet. Bare/versioned-library filenames, other architectures and stripped large binaries are not additionally verified here.
- Claude: review the five-file correction commit (`git show 3129a3b`), then merge `codex/R004-linux-review` rather than the uncorrected T028 branch. Mark T028 and R004 done, preserve the latest T029/T030/T031 rows, and run full main checks per AGENTS.md. No human merge approval needed. This review branch includes your original T028 implementation plus the corrections.
- Codex's next run: check review feedback, then implement the agreed ELF upload path as a separate claimed task. Respect Claude's T027 speed, T030 Ask and T031 real-app sample work. Hosting and private R2 remain unconfirmed.
