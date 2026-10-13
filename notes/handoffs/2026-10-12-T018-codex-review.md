# T018 — Cloudflare deployment review (codex)

**Branch:** `codex/T018-review`, reviewing `claude/T018-cloudflare` @ `4444a41`.
**Status:** approved for merge; deployment itself awaits the human's push.

## What changed

- Combined Claude's branch with main @ `103923b`, preserving the current UI,
  branding, local mode, Ask, tours, fonts and all six workspaces. Kept every
  current task row when resolving the old branch's conflicts.
- Approved Next.js `16.3.8` with OpenNext `1.20.10` and Wrangler `4.148.0`.
  Upstream [issue #1448](https://github.com/opennextjs/opennextjs-cloudflare/issues/1448)
  is still open and reports the `preview-props.json` failure on Next `16.4.0`.
  The adapter's actual peer security floor is `16.3.8` for Next 16.
- Regenerated the lock from current main instead of discarding newer workspace
  dependencies. A root Next override plus deduplication removes the stale
  `16.4.0` adapter peer: both site and adapter now resolve `16.3.8`. Existing
  dependency version changes are limited to Next and its matching env/SWC
  packages; other dependencies were preserved, with Cloudflare tools added.
- Deployment now requires typechecks and all workspace tests. Cloudflare
  credentials are present only in the presence-check and deploy steps, not in
  dependency installation or the build. Missing secrets still mean build only.
- Corrected the guide's outdated tool versions, made the purchased domain
  optional, and linked the Cloudflare guide from README.

## Verification

- Windows: all six workspace typechecks, 94 tests (web 4, worker 31, CLI 8,
  adapter 37, Ask 14), and the production build pass. Windows junction/child
  process tests require normal user access outside the restricted sandbox.
- Clean Linux rehearsal using the worker's pinned Node 24.18.0 Debian image:
  `npm ci --ignore-scripts`, shared package builds, all typechecks, all 94 tests,
  then the actual OpenNext build pass. The slim image needed `procps` for REA's
  owned-child inspection; the standard Ubuntu CI runner already supplies `ps`.
- Final local workerd preview: `/`, `/open`, all three `/explore/<slug>` demos,
  `/projects/index.json` and the tiny project JSON return 200. Unknown demo and
  missing static-file requests return 404. JS/CSS assets return 200 with the
  intended immutable cache header.
- Browser: homepage hydrates the real 28-node/58-link demo; Ask opens with a
  blank visitor-key field; `/open` reads a real normalized file into the graph.
  No paid Anthropic request was made.
- Wrangler's local deploy dry run passes: 34 static assets; Worker upload
  6214.30 KiB uncompressed / 1301.91 KiB gzip. No account or token used.
- Screenshot outside Git: `C:\Users\sulai\Downloads\REA for Web\cloudflare-preview-verified.png`.

## Not done / known issues

- Nothing pushed or deployed. The human reports adding both GitHub secret
  names; this could not be independently verified because the available browser
  is logged out and the connector cannot list Actions secrets.
- First deployment includes demos, the local-file viewer and BYOK Ask. Hosted
  uploads still need storage, a queue connection and a trusted Docker host;
  T007 remains a separate cross-review. No domain purchase is required.
- Static-assets incremental cache is correct for this main branch's prerendered
  pages. When reviewing T007 on Workers, check dynamic routes and backend
  bindings separately. Ordinary SSR does not itself require an ISR cache.

## Interface changes or questions for the other agent / human

- No StudioProject or upload-API changes in T018. The shared Next pin is approved.
- Codex will integrate this main into T007 and record local upload compatibility
  before Claude merges that task. Do not claim the hosted upload flow is ready.
- Human pushes from GitHub Desktop; the named Actions workflow deploys only
  after its checks and the credential presence check pass.
