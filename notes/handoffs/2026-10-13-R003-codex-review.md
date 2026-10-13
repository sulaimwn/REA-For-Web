# R003 — Independent program worker review (codex)

**Branch:** `codex/T021-native-android-review`
**Status:** approved, alongside R002. Reviewed Claude's committed T024 snapshot `e0b9484`; his checkout was not edited.

## What changed
- The .NET/native/Android worker selection, fixed image allowlist, read-only mounts, environment-controlled image selection and unchanged Docker restrictions pass review.
- Fixed a real admission gap: APKs counted as one file, ignoring their archive entries and expanded sizes. Bounded ZIP directory inspection now enforces those budgets before REA runs. Unsafe names, symlinks, encrypted/split/ZIP64 formats, malformed directories and directories over 8 MiB are rejected. No files are extracted for admission.
- ZIP framing follows [PKWARE APPNOTE 4.3.12 and 4.3.16](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT).
- CI builds both pinned worker images and sets `REA_REQUIRE_NATIVE_TESTS=1`; provider checks cannot silently skip there. Added actual native-provider cancellation and APK-cap assertions.
- Corrected obsolete worker docs that still claimed Docker was missing and described five unverified tests.

## How verified
- Worker unit/lifecycle tests: 37/37, including real APK metadata, forged oversized expansion, truncated ZIP and entry-count rejection.
- Both images rebuilt from the review checkout, including R002's adapter/session fixes.
- Real Docker: 11/11 pass, zero skips, 120 s total. Covers actual .NET metadata, Ghidra native analysis (39.7 s), JADX APK analysis (18.7 s), original ASAR/directory behavior, partial timeout evidence, bad/oversized inputs, output limits, cancellation and container cleanup.
- Android result retains five unknown constructors/initializers and partial coverage. APK entry cap produces `input_limit_exceeded` with no published result. Native cancellation removes the container and incomplete output.
- Every integration test checks the worker-container inventory returns to its initial state.
- Full workspace checks on merged main are recorded after the merge.

## Not done / known issues
- Upload pipeline remains ASAR-only until Codex's next task. These images and demos alone do not enable hosted program uploads.
- Native image must exist on the analysis host, with `REA_NATIVE_WORKER=1` for native/APK queue jobs. Website capture still needs its separate network-isolated capture design.
- APK expanded-byte checks trust ZIP's declared metadata; Docker memory, tmpfs and deadline restrictions remain the enforcement backstop for malformed parser inputs. Unsupported ZIP formats are rejected deliberately.
- Native function queries and Android deep method queries can still hit the independent job deadline on large targets.

## Interface agreement
Approve the existing worker option `native`, CLI `--native`, and operator `REA_NATIVE_WORKER=0|1`. Neither upload callers nor artifact bytes can choose an image or change sandbox limits.
