# Claude 48-hour loop — final handoff (2026-10-13 → 2026-10-15)

The hourly loop (cron `d3079cbd`) is stopped. No uncommitted Claude work remains. Nothing was pushed by Claude.

## Live now (verified)
- **reaforweb.com** (Cloudflare Workers):
  - 13 demos, including **jq (macOS)**;
  - free Ask (Workers AI);
  - link-preview card, favicon, GitHub links;
  - readable big-program maps.
- **Public uploads, no key:** https://uploads.reaforweb.com/upload on the Netcup VPS (€14.01/month).
  - Local-disk storage (the human's Option B), bounded at 64 GiB ext4 and private.
  - Codex verified a real visitor upload (T058). A no-key `POST {}` returns a 400 validation error, not a 403.
  - HSTS and nosniff are on.

## Claude work merged during the loop
- **Launch:** T037 (favicon and metadata), T040 (link-preview card), T041 (free Ask budget and binding).
- **Explorer and demos:** T045 (entry-point overview for big programs), T049 (jq macOS demo, named-parts-first overview,
  import titles).
- **Analysis:** T035 (macOS Mach-O adapter, CLI and worker), T046 (`REA_ANALYSIS_CPUS`; Ghidra about 2.4× faster on 2 CPUs).
- **Reviews of Codex work** that I merged: T036, T039, T042, T047, T048, T050, T051, T052, T053, T054 (design), T055, T056.

## Awaiting review
- **T057 `claude/T057-input-limits` @ `ea1639a`**: the human's WhatsApp APK failed with `input_limit_exceeded`.
  - APK ZIP entries no longer count as app files. They're still bounded by ZIP's 65,534 entries (ZIP64 refused),
    the 8 MiB directory cap and the unpacked-byte cap.
  - Default `maxFiles` goes from 5,000 to 20,000.
  - New operator settings: `REA_ANALYSIS_MEMORY_MB`, `_HEAP_MB`, `_MAX_FILES`, `_MAX_INPUT_BYTES`.
  - Readable messages for input, memory and output limit failures.
  - 268 tests, 267 pass, 0 fail. It merges cleanly with main apart from TASKS.

## Next steps (in order)
1. **Codex:** review, merge and deploy T057. Set on the worker:
   `REA_ANALYSIS_CPUS=2 REA_ANALYSIS_MEMORY_MB=5120 REA_ANALYSIS_HEAP_MB=4096 REA_ANALYSIS_TIMEOUT_MS=1800000
   REA_ANALYSIS_MAX_INPUT_BYTES=1073741824`. Then retry a big real APK.
2. **Raise the public ceilings** (constants in `packages/pipeline/src/admission.ts`, ideally operator settings).
   The human wants much less restrictive limits. Suggested: 10/network/day (keep 5/hour), 300/day site-wide,
   5,000/month. Local disk makes abuse cost nothing extra; the pending cap and the disk bound protect the host.
3. **Turnstile** (release 2, `PIPELINE_TURNSTILE=1`). The human creates the widget in Cloudflare.
   Claude offered to build the challenge and queue-position UI once Codex adds a `position` to the job status.
4. **Suggested:** automatically reclaim leaked `+inf` admission-pending entries (see the T055 review).
5. **Formats needing the human's approval:**
   - universal macOS binaries (needs a sample download);
   - iOS `.ipa` (needs a non-App-Store sample);
   - Java `.jar` (untested).
