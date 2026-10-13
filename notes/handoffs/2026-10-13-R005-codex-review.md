# R005 — T030 / T031 / T033 release review (codex)

**Branch:** `codex/R005-release-review`, own checkout `rea-web-codex-R004`.
**Corrections:** `a71cbb8`. Includes all three Claude branches and current main/T034.
**Status:** checks in progress; original T030 is not approved yet. Nothing pushed.

## Independent findings and corrections
- Reproduced T030's multi-tool overflow in a regression: a valid three-call reply
  eventually sends **26 messages**, beyond the route's maximum 24. The browser
  loop now reserves a final instruction before every tool pair and stops cleanly
  on message/context limits or oversized model arguments.
- UTF-16 character counts did not bound multilingual context or serialized HTTP
  bytes. An 8,000-byte UTF-8 conversation ceiling leaves room for fixed tools,
  system prompt/output and worst-case JSON escaping in the 64 KiB request.
  Per-result truncation preserves surrogate pairs. The server enforces the same
  ceiling and forwards only validated role/content fields.
- Regression cases cover multi-call replies, multilingual/escaped results,
  oversized arguments and removal of unvalidated message metadata.
- T031's default-package count is real; names alone don't prove R8/ProGuard was
  responsible. Its finding now labels minification as a Studio heuristic, and
  the Binary Eye description reports omitted `defpackage` classes directly.
- T033's native imports are calls into external code, not necessarily OS system
  calls. Corrected this wording. No shared schema or API field shapes changed.
- Removed the unsupported fixed number-of-free-questions estimate from deploy
  docs and qualified code comments that said requests could never bill.

## Cloudflare deployment review still open
Cloudflare's primary docs (checked October 13):
- [Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/):
  10,000 free neurons/day; Workers Free stops at the allowance; Workers Paid
  bills usage above it. The original deployment enables AI automatically and the
  account's plan hasn't been independently confirmed. The in-isolate limiter is
  a soft visitor throttle, not an account spending cap.
- [Model schema](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/):
  selected model supports function calling and a 24,000-token context.

**Claude:** please independently review `a71cbb8` before these corrections merge.
Please resolve the deployment cost boundary before enabling T030 on an unknown
account plan: default-off until a Free plan is confirmed, or a reviewed durable
global allowance that refuses requests before overages. A spending alert alone
doesn't enforce the human's free-only request. Please coordinate any new binding
or shared interface in a handoff first. No purchases/account changes needed.

## Verification so far
- Initial integrated all-workspace typecheck passed before corrections.
- Caprine fixture: 919 nodes / 1,137 edges, zero dangling graph edges; original
  counts and 7,451 omitted dependency gaps retained in trim metadata.
- All three new fixtures parse and contain no Windows user/Linux home paths.
- Full corrected workspace tests and browser/build checks are in progress;
  final results will be appended here before completion.

## Next
Finish checks on this exact integrated branch, then record approval by Claude
for the corrections. Merge passing branches with latest task rows and run full
main checks. T034 is already independently approved/merged by Claude.
