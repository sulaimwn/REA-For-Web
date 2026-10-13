# R005 — T030 / T031 / T033 release review (codex)

**Branch:** `codex/R005-release-review`, own checkout `rea-web-codex-R004`.
**Corrections:** `a71cbb8`, `eab9d58`, `898a365`.
Includes all three Claude branches, reviewed T034 and current T035 coordination.
**Status:** review. Integrated code passes; Claude's independent review of these
corrections is the remaining merge step under AGENTS.md. Nothing pushed.

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

## Cloudflare deployment cost boundary resolved safely
Cloudflare's primary docs (checked October 13):
- [Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/):
  10,000 free neurons/day; Workers Free stops at the allowance; Workers Paid
  bills usage above it. The original deployment enables AI automatically and the
  account's plan hasn't been independently confirmed. The in-isolate limiter is
  a soft visitor throttle, not an account spending cap.
- [Model schema](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/):
  selected model supports function calling and a 24,000-token context.

The human replied that they bought a domain and don't know the Workers plan.
`eab9d58` therefore comments out the production AI binding until Workers Free is
confirmed; no plan changes, purchases, account access or AI calls were made.
Docs explain that a domain purchase doesn't establish a Workers plan and that
alerts aren't hard spending caps. `898a365` makes the home page describe free Ask
as available where enabled instead of promising it on an unconfigured host.
The default configuration cannot run Workers AI, even if the account is Paid.
The existing API already returns 503 and the panel offers the visitor's own key.

**Claude:** please review all three corrections and merge this integrated branch
after approval. No human merge approval or messenger prompt is needed. If enabling
AI later, confirm Workers Free or first agree a durable hard allowance in a
handoff; the soft per-isolate visitor limiter is not a spending cap.

## Verification complete
- All eight workspaces typecheck after code corrections. Full final production
  build (including `898a365` availability copy) passes.
- All workspace tests: **247 tests, 246 pass, one host-JADX case skipped** because
  `REA_JADX_MCP_JAR` isn't set; zero failures. Includes 24 web, 38 worker, 111
  adapter, 28 pipeline, 22 Ask and seven MCP tests; CLI has 16 passes/one skip.
  Verified the log includes the new default-package qualification and both
  multi-call/multilingual Ask regressions. Providers/sandbox haven't changed, so
  unrelated Docker native analysis suites weren't repeated.
- Negative regression before fix fails with `AssertionError: 26 messages`.
- Caprine fixture: 919 nodes / 1,137 edges, zero dangling graph edges; original
  counts and 7,451 omitted dependency gaps retained in trim metadata.
- All three new fixtures parse and contain no Windows user/Linux home paths.
- Independent Cloudflare Linux/OpenNext build passes. Browser checks use its
  production build; the last copy-only change was separately verified in the
  final Windows production build. Mounted final `wrangler.jsonc` into the own
  preview; `wrangler deploy --dry-run` confirms **no AI binding** and no actual
  deploy. Compressed worker 2,009 KiB; services/assets are the only bindings.
- Actual Cloudflare runtime: same-site Ask returns 503 and another Origin 403.
  Browser 503 fallback opens the visitor's key form without a model call.
- Real Ask UI -> actual `handleFreeAsk` -> explicitly scripted model stand-in ->
  real project tools -> cited answer: three lookups, `notes:save` highlighted,
  zero browser console errors. **Not a real Workers AI inference/quality test.**
- Caprine, jq and Binary Eye render: Caprine shows trimmed/partial coverage;
  jq shows 906 functions, 214 imports and generic-name limits; Binary Eye shows
  18 components, 11 permissions, 169 methods and the 2,542 omitted-class note.
- Phone override 375 px: available document width 360 = scroll width 360
  (scrollbar uses the difference), both labeled groups and all 11 demo tabs;
  no horizontal page overflow. Override reset afterwards.
- Logs in shared parent: `R005-typecheck-final.log`, `R005-tests.log`,
  `R005-build.log`, `R005-cloudflare-build.log`, `R005-wrangler-dry-run.log`,
  `R005-proxy.log`; screenshot `R005-ask-check.png` labels the scripted stand-in.
  Own ignored harness `.host-test-r005/proxy.mjs` uses no credentials and sends
  public sample data only to a loopback stand-in.

## Next
Claude reads the correction diff and reruns appropriate checks. After approval,
merge `codex/R005-release-review` into main with `--no-ff`; mark T030/T031/T033/R005
done and preserve T035/T034 and any newer task rows. Run full main checks. This
branch already includes all three original Claude branches, so no separate
merges or manual patch copying are required. T034 is already merged and checked.
Live upload hosting/private storage and a real free-plan AI test remain external
setup steps; code readiness is not a claim of a live deployment.
