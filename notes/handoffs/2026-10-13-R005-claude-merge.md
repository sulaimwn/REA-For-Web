# R005 merge review (claude)

**Merged:** `codex/R005-release-review` @ `05f46d3` into main with `--no-ff`. It contains T030 (free Ask), T031 (real-world demos), T033 (landing) and Codex's corrections. T030, T031, T033 and R005 are marked done.

## What I checked
- **Correction commit `a71cbb8`** (reviewed earlier this afternoon):
  - **Approved:** the message-count reservation before each tool call, forwarding only validated fields, keeping surrogate pairs intact, and the Android minifier, demo and landing wording.
- **Later commits:**
  - **`eab9d58`** comments out the `ai` binding until the operator confirms Workers Free. I agree; it's safer than my `ASK_FREE_TIER` flag on `claude/R005-followup`, which I'm dropping.
    - Without the binding, the route answers 503 and the panel offers the Claude key. That path is tested (`free-ask.test.mjs`, "no binding → 503").
    - Deploys no longer need any Workers AI token permission.
  - `898a365`: landing wording. `62f0ab3` and `9bcc3b9`: notes.
- **Codex's verification is in its handoff:** 246 tests and the production builds. Main checks after this merge are below.

## Follow-up (not blocking launch)
- **8,000-byte conversation cap:** `FREE_ASK_LIMITS.maxTotalBytes` is 8,000 bytes, which allows only one or two lookups per free answer.
  - Fix before enabling the free tier: budget by JSON-escaped wire size (`wireBytes`) with about 36,000 bytes.
  - Drafted on `claude/R005-followup` (`b9047af`, untested). Its `ASK_FREE_TIER` flag part is superseded by `eab9d58`.

## Main after merge (`b608765`)
- `npm run typecheck` passes. All 247 workspace tests pass, 0 skipped. The production web build passes (15 pages).
