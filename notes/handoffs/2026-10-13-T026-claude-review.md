# T026 review — hosted upload deployment kit (claude)

**Branch reviewed:** `codex/T026-hosted-uploads` @ `a8f4137` (code `a3bbd7b`, on top of reviewed T025)
**Verdict:** approved and merged into main with `--no-ff`. T026 marked done.

## What I checked
- **Diff read in full:** `upload-location.ts` and the pages/header using it, `next.config.ts`, `deploy/linux/*` (Dockerfile.web plus its `.dockerignore`, compose, Caddyfile, systemd unit, `check-worker.mjs`, env examples) and `scripts/check-hosted-deployment.mjs`.
- **Trust boundaries:**
  - **Navigation:** `REA_UPLOAD_ORIGIN` accepts only a bare `https://` origin. URLs with credentials, a query, a fragment or a path are rejected, and no keys or job tokens cross sites.
  - **Web image** (I built my own, `rea-for-web-upload:claude-review`):
    - runs as uid 1000;
    - contains no `upload-secret`, `.env` or `*.env` files (checked inside the image);
    - its `.dockerignore` excludes `.pipeline-*`, `.env*`, notes, samples and `node_modules`.
  - **Compose:**
    - web is read-only with capabilities dropped, no Docker socket and no staging mount;
    - Redis and web publish on loopback only;
    - only optional Caddy publishes 80/443, with a 1 MB body cap, since files go straight to R2.
  - **Host queue:** the systemd unit is restricted (`ProtectSystem=strict`, writes only to staging). Its preflight prints only the failed stage, never values. Docker-group membership is called out as administrative.
  - **Analysis sandbox:** unchanged. T026 doesn't touch the worker.
  - **Test script:** cleanup is confined to a random `rea-host-test-<hex>` Compose project and its own temp dir.
- **My own checkout:** `npm ci`, typecheck passes, all **206 tests pass**, 0 skipped.
- **`HOST_TEST_RELEASE_TAG=claude-review npm run test:hosted`** passes in 150 s:
  - web restrictions, private Redis, persistence across restart, host preflight;
  - real HTTP 2/2 (ASAR, .NET EXE/DLL, Ghidra EXE, JADX APK, dedupe, renamed-format rejection);
  - cleanup: no containers or volumes left behind.
- **`Dockerfile.cloudflare-check`** builds: the OpenNext build is complete. The regular Cloudflare config is unchanged unless `REA_NODE_DEPLOY=1`.

## Non-blocking notes for when a host is chosen
- **Redis has no password.** It relies on loopback plus the private bridge, and analysis containers have no network. On a shared host, add `requirepass`/ACL to both env files as defense in depth.
- **Docker CLI config under systemd.** With `ProtectHome=true`, the Docker CLI can't write `~/.docker`. If the real systemd run warns, set `DOCKER_CONFIG` to a directory under staging. This belongs to the operator checks the handoff already lists.
- **Speed is unchanged:** analysis still has one global slot. My Obsidian timing (458 s, nearly all REA analysis) is in the T025 review note.

## Main after merge (`eee46bc`)
- `npm run typecheck` passes. All 206 workspace tests pass, 0 skipped.
