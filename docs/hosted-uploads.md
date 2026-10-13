# Hosted uploads (T026)

This is a deployment kit for a **dedicated Linux Docker host**, not a deployed
service. The Cloudflare site continues to serve demos, local mode and Ask. A
separate HTTPS analysis site serves the existing upload form/API and authenticated
job explorer. Large file bytes go directly from the browser to private R2.

The host has three trust boundaries:

- The web container can access R2 and private Redis, but has no Docker socket,
  Docker CLI or staging directory mount. It runs as uid 1000 with a read-only root.
- The trusted Node queue service runs on the Linux host as `rea-worker`. Its
  Docker-group membership grants control of that dedicated machine's Docker
  daemon. This is an administrative service account, not an uploaded-program
  identity. Do not use a shared machine containing unrelated private workloads.
- Every analysis still runs in the reviewed disposable container: no network,
  non-root, read-only root, no capabilities, bounded memory/CPU/files/output/time.
  Targets are never executed. The analysis container receives no cloud credentials
  or Docker socket. The staging path is a real host path so Docker bind mounts
  refer to the same verified file.

Redis is on a private Docker network with a loopback-only host port for the queue
service, persistent append-only data and `noeviction`. Only the website and trusted
local host processes can reach it. HTTPS is an optional Caddy profile; only ports
80 and 443 are public when that profile is enabled. Its 1 MB request-body cap
allows the small API requests; uploaded artifacts go straight to R2.

## Prerequisites

- Dedicated Linux host with a working Docker Engine/Compose **2.30+**, Node at
  `/usr/bin/node` (24.11+ on the 24.x line), and systemd. The built web image pins
  Node 24.18.0. Verify the actual node path before installing the unit.
- Plan about **8 GiB of RAM** for this initial single-job setup, including the
  2 GiB analysis container, website, queue, Redis and OS headroom. This is capacity
  planning, not measured production sizing or a hosting purchase recommendation.
- An HTTPS hostname pointing to that host, and a private Cloudflare R2 bucket
  with bucket-scoped object read/write credentials. A `workers.dev` hostname
  cannot be pointed at a separate Linux server through ordinary DNS; use a host
  provider's HTTPS domain/reverse proxy or a domain you control.
- R2 CORS allowing PUT from the exact analysis-site origin and Content-Type;
  a lifecycle rule deleting `uploads/` objects after one day. Keep the bucket
  private. Never put R2 credentials into Cloudflare's browser bundle.

No server, bucket, domain, billing plan or credentials are created by these files.
The existing GitHub Cloudflare deployment token is not an R2 object-storage key.

## Install a reviewed release

Use a reviewed commit containing T025 and T026. Checkout that commit under
`/opt/rea-for-web`, owned by the administrator and not writable by `rea-worker`.
Use only official Docker/Node installation sources appropriate to the host OS.
The following commands are intended for that Linux server, not Windows PowerShell.

```sh
cd /opt/rea-for-web
npm ci --ignore-scripts --no-audit --no-fund --workspace=@rea-studio/worker --include-workspace-root
npm run build --workspace=@rea-studio/schema
npm run build --workspace=@rea-studio/rea-adapter
npm run build --workspace=@rea-studio/pipeline
npm run build --workspace=@rea-studio/worker
docker build -f apps/worker/Dockerfile -t rea-studio-worker:rea-6.4.0 .
docker build -f apps/worker/Dockerfile.native -t rea-studio-worker-native:rea-6.4.0 .
```

Create a system account `rea-worker` with primary group `rea-worker` and access to
the Docker group. Create `/var/lib/rea-for-web/staging`, owned by that account,
mode 700. The unit's writable directory must match `PIPELINE_WORK_ROOT`.

Create `/etc/rea-for-web`, owned by root and mode 700. Copy the two example files
from `deploy/linux/` there as `web.env` and `worker.env`, root-owned and mode 600.
Replace every placeholder using the operator's secret manager/editor. Do not
paste secret values into chat, commit them, print environment files, or run
`docker compose config` without `--quiet` on real credentials.

Both files must agree on R2 settings, exact public HTTPS origin, queue prefix and
beta access key. The web container uses `redis://redis:6379`; the host queue uses
`redis://127.0.0.1:6382`. The private environment files are read at runtime, never
used during the image build. `env_file: format: raw` avoids interpolation of `$`
inside secrets by Compose. The systemd environment file does not expand shell
variables either; quote values according to systemd's EnvironmentFile syntax.

From the repository root, select a release tag, the real hostname and environment:

```sh
export WEB_ENV_FILE=/etc/rea-for-web/web.env
export RELEASE_TAG=reviewed-commit-id
export UPLOAD_HOST=uploads.your-domain.example
docker compose -f deploy/linux/compose.yml config --quiet
docker compose -f deploy/linux/compose.yml build web
docker compose -f deploy/linux/compose.yml up -d redis web
```

Install `deploy/linux/rea-upload-worker.service` under `/etc/systemd/system/`.
Confirm `/usr/bin/node`, `/opt/rea-for-web`, the service user/groups and private
environment paths exist. Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now rea-upload-worker
sudo systemctl status rea-upload-worker --no-pager
docker compose -f deploy/linux/compose.yml --profile tls up -d https
```

The worker's startup check has a 35 s deadline. It verifies Linux Docker safety,
both required image tags, staging permissions, Redis and a read-only HEAD request
to an intentionally absent result key in storage. It never writes a test object
or logs credential values. Failures keep the queue service from starting; the
service retries with a bounded restart rate.

If a provider already terminates HTTPS, omit Caddy and proxy to the loopback web
port 3116. Pass the original HTTPS hostname; `PIPELINE_PUBLIC_ORIGIN` must exactly
match the browser Origin. Do not expose the web or Redis ports directly. The
form requires the private-beta access key before issuing R2 upload tickets.

## Connect the Cloudflare site

After the analysis site is verified, set **REA_UPLOAD_ORIGIN** to its HTTPS
origin in the website Worker's runtime variables, for example
`https://uploads.your-domain.example` (no path, query, credentials or fragment).
Use a non-secret runtime variable, not `NEXT_PUBLIC_*` or an API credential.
The dynamic homepage/navigation links to that site's `/upload`, and the existing
Cloudflare `/upload` page offers the same link. The analysis site hosts its own
form, API and job pages. No cross-origin API proxy or token sharing is involved.

Before setting this variable, Cloudflare continues to offer local mode. Do not
set `PIPELINE_STORAGE` or R2/Redis credentials on the Cloudflare frontend for this
deployment. Those belong only to the Node service and host queue.

## Verify before inviting users

1. Check that web and Redis are healthy, the host queue is active, and only the
   reverse proxy is publicly reachable. Check `journalctl -u rea-upload-worker`
   for sanitized startup/completion/failure messages.
2. Open the HTTPS `/upload` page, enter the beta key and choose the public tiny
   Electron fixture packaged as ASAR. Confirm upload progress, queue/analysis
   progress, and a finished graph with evidence. Raw files go to R2.
3. Repeat with the public .NET, native EXE and APK fixtures. Missing Android method
   bodies must remain partial coverage, not disappear. Upload the same artifact
   again to verify dedupe still requires verified possession.
4. In a different browser session, a job URL alone must not disclose a result.
   Malformed inputs and wrong hashes must not publish a project.
5. Verify R2 raw-object deletion after success/failure and one-day expiry, staging
   cleanup and zero remaining `rea-studio.worker=true` containers after each job.
6. Only then enable the Cloudflare link and test that navigation from the public
   site reaches the correct analysis site, without any token/key in the URL.

The existing `test:http` fixture tests refuse non-loopback destinations. That is
deliberate. Production validation uses the browser and operator checks rather
than disabling that test guard.

## Updates, recovery and rollback

- Preserve Redis/R2 data and the queue prefix across releases. Never use
  `docker compose down --volumes` during an update; that destroys queue state.
- Let the current job finish before stopping/updating the queue. The systemd
  stop timeout covers the maximum configured job deadline plus cleanup. Build
  images and compiled host code before replacing a reviewed release.
- Tag the web image with its reviewed commit, keep the previous image and host
  checkout, then recreate only the web service and restart the queue. Keep the
  API and worker at the same reviewed version.
- To pause new public uploads, unset `REA_UPLOAD_ORIGIN` on Cloudflare and stop
  the HTTPS service. Existing direct links are still reachable if an external
  reverse proxy remains enabled; disable that route too. Let queued work drain.
- Roll back both the web tag and host checkout. Verify cache-key compatibility
  in that release first. T025 reads old ASAR cache revisions 2–6 and writes
  revision 7 partitioned by file kind. Do not run an older ASAR-only worker
  against queued program/APK jobs.
- A force-killed worker can leave Docker work running until its own deadline.
  Before restart, inspect containers with `rea-studio.worker=true`; remove only
  confirmed orphan analysis containers on this dedicated host. Never prune
  unrelated containers or data. Stalled jobs fail; raw/staging expiry sweeps are
  the cleanup backstop.
- R2 lifecycle cleanup is independent of this host. Preserve it even if the
  server is stopped. Keep result caches private and back up Redis persistence.

## Limits and verification status

This kit keeps one global analysis job at a time, 1 CPU / 2 GiB per analysis,
512 MiB input cap and the existing 15-minute deadline. No settings were increased
based on guesses about upload speed. Measure real stages before changing limits.

Each R2 operation has a 60-second deadline covering SDK attempts and retry
backoff, including metadata reads, download response headers, result publication,
raw deletion and expiry-list requests. The downloaded byte stream also has its
existing 60-second limit. A storage timeout fails the job and releases its local
staging directory. If raw deletion itself times out, the job reports cleanup
failure and R2's lifecycle rule/expiry sweep must remove the remaining object.
An interrupted PUT can have reached storage even when its response was lost;
the job does not receive a successful result receipt in that case.

`npm run test:storage --workspace=@rea-studio/pipeline` checks these cases using
the real S3 SDK against an isolated loopback HTTP service, with inert test keys.
It does not connect to R2 or verify a production bucket's permissions.

Local packaged-service checks and remaining deployment limitations are recorded
in `notes/handoffs/2026-10-13-T026-codex.md`. Real server/systemd installation,
public TLS/DNS and live R2 need operator credentials/infrastructure and remain
separate validation steps.

To repeat the isolated local deployment test after installing dependencies and
building both reviewed analysis images:

```powershell
docker build -f deploy/linux/Dockerfile.web -t rea-for-web-upload:t026 .
npm run test:hosted
```

The test builds the host queue code, uses an isolated Compose project and
loopback ports 3116/6382, checks read-only/non-root web settings, host startup,
Redis persistence and the existing real HTTP tests for all five analysis kinds
(six admitted extensions, including the `.so` alias for ELF).
Set `HOST_TEST_WEB_PORT` / `HOST_TEST_REDIS_PORT` if needed. `HOST_TEST_RELEASE_TAG`
selects the locally built web tag. It uses generated private local test objects
instead of R2 and cleans up only its own temporary directory and Compose volumes.
It does not touch the normal upload stack or production data. Linux users running
this local-storage test must own the temporary objects as uid 1000, matching the
web image; the production R2 deployment has no local objects mount.

`Dockerfile.cloudflare-check` separately builds the normal Cloudflare output
for local Wrangler preview; `REA_NODE_DEPLOY=1` is used only in `Dockerfile.web`.
The normal Cloudflare CI remains unchanged.

Primary references: [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/),
[Compose services](https://docs.docker.com/reference/compose-file/services/),
[Next standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output),
[systemd execution settings](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html),
and [private R2 upload setup](uploads.md).
