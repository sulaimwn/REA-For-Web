# Upload pipeline (T007)

The browser hashes an .asar file in 4 MB chunks, requests a signed upload ticket,
uploads it, and explicitly completes the upload. Redis/BullMQ holds the job until
a separate trusted worker downloads and verifies its size and SHA-256. The worker
calls the existing Docker sandbox and stores only compressed StudioProject JSON.
The uploaded target is never executed. Storage and Redis credentials never enter
the analysis container or browser.

## Try it locally

With Docker Desktop running, from the repository root:

```powershell
npm ci --ignore-scripts
npm run dev:uploads
```

Open http://localhost:3104/upload and choose an .asar file (up to 512 MB).
The helper builds the web app and analysis image, starts a Redis container bound
to 127.0.0.1:6380, and runs the web app and trusted queue worker. Ctrl+C stops its
services. Use UPLOAD_DEV_PORT / UPLOAD_REDIS_PORT if those ports are occupied.

Local objects and the signing secret live in gitignored `.pipeline-data/`;
private staging is in `.pipeline-work/`. Redis uses the named Docker volume
`rea-studio-upload-redis` with append-only persistence and no eviction. This is
local development, not a filesystem storage option for serverless deployment.
Keep both directories private to the service account. The signing secret is
generated once and never logged.

## API

- POST /api/uploads, JSON `{name, bytes, sha256}` → `{jobId, jobToken, uploadUrl,
  headers, expiresAt}`. Only .asar files are supported in this first upload flow.
- PUT the file bytes to uploadUrl, with the returned headers. A ticket expires
  after ten minutes. The local endpoint verifies bytes before publication; R2
  signatures bind Content-Type and Content-Length, and the worker independently
  verifies every downloaded byte.
- POST /api/uploads/:id/complete with `Authorization: Bearer <jobToken>` queues
  the uploaded object. Completion is idempotent. Requests from the browser must
  have the configured Origin; R2 mode additionally requires X-REA-Access-Key.
- GET /api/jobs/:id with that bearer token → awaiting-upload / queued / running /
  succeeded / failed, REA progress text, and projectId/cacheHit on success.
- GET /api/jobs/:id/project with that token streams compressed StudioProject
  JSON (Content-Encoding: gzip); ordinary fetch transparently decompresses it.

Job access expires after 24 hours. Tokens are kept in sessionStorage, never in
URLs. A result URL can be reloaded in its uploading tab; opening it in a different
browser session requires uploading the app again. There is no public hash lookup.
The server admits at most 100 upload tickets per UTC day for the private beta.

## Cache identity and retention

The uploaded file SHA-256 is separate from REA's subject/project id. Cache keys
include schema 0.1.0, REA 6.4.0 and adapter/cache revision 4. Increment the cache revision
when adapter semantics or analysis settings change. Cache reuse happens only
after the worker has downloaded and verified a fresh upload with the same hash.
This proves possession before exposing a cached result.

Analysis concurrency is globally one per queue. A job is acknowledged as complete
only after result storage and raw-object/staging cleanup finish. Deterministic
analysis failures are not retried automatically. Worker crashes are marked failed
on stalled-job detection; the container's own deadline remains in force.
Normalized results stay in the private cache. Raw uploads and abandoned staging
older than 24 hours are swept at worker startup and hourly while it runs.
Queued records older than 24 hours are rejected before analysis.

Analysis has a 15-minute whole-job deadline, enforced by both the host and the
container. On slower machines the operator can set `REA_ANALYSIS_TIMEOUT_MS`
on the trusted queue worker (1,000–1,800,000 ms; maximum 30 minutes). Upload
requests cannot change it. CPU, memory, file and output caps still apply.
Each source has a separate three-minute deadline (`REA_SOURCE_TIMEOUT_MS` on the
trusted worker; it must fit within the whole-job deadline). REA reports a source
timeout as `provider_timeout` with retained application Evidence. The adapter
accepts that Evidence only with explicit opt-in, valid application/graph/digest
fields, partial coverage, and no incomplete-cleanup report. The worker handles
REA's nonzero exit only for this checked timeout case. The result opens with
partial coverage and REA's analysis gaps; files after the interrupted source have
not been analyzed. No facts are invented to fill those gaps.

Other errors, whole-job deadlines, missing/malformed Evidence and cleanup
failures still fail without a project. Failed jobs show the last progress step
and a link to upload again; they cannot resume because raw uploads and partial
output files were removed.

## Connect Cloudflare R2 later

No bucket, account resources or credentials were created during T007. The R2
adapter's signing is tested offline; live R2 integration remains to be checked.

Use a dedicated private bucket and bucket-scoped object read/write credentials.
Configure the web server and trusted worker using `.env.example`:

- PIPELINE_STORAGE=r2; PIPELINE_PUBLIC_ORIGIN must be the exact HTTPS web origin.
- R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.
- REDIS_URL for a private Redis endpoint (rediss:// for external TLS connections),
  with persistence enabled and maxmemory-policy=noeviction. BullMQ uses native
  Redis connections; an HTTP-only Redis API is insufficient.
- PIPELINE_ACCESS_KEY: a random secret of at least 32 characters for this private
  beta. The operator supplies it through the upload form; it is never embedded in
  browser bundles. Public anonymous uploads need a separate admission/auth design.
- PIPELINE_QUEUE_PREFIX must match on web and worker; PIPELINE_WORK_ROOT is a
  private writable staging directory on the Docker host.

Keep secrets in deployment settings or ignored environment files, never Git.
The Next.js service hosts the API; a long-running Node service with a Linux Docker
engine hosts `apps/worker/dist/queue.js`. It is not a Vercel background function.
For example, after a root build, load an ignored local file explicitly:

```powershell
node --env-file=apps/web/.env.local apps/worker/dist/queue.js
```

Set bucket CORS to allow PUT from the exact web origin, with Content-Type allowed.
Add a bucket lifecycle rule expiring the uploads/ prefix after one day. Presigned
R2 URLs can be reused until expiration, so a late repeat PUT may recreate an
already-deleted raw object; the lifecycle rule is the independent cleanup backstop.
Do not enable public bucket access or return raw-object download links.

See the official [R2 presigned URL guide](https://developers.cloudflare.com/r2/api/s3/presigned-urls/),
[R2 CORS guide](https://developers.cloudflare.com/r2/buckets/cors/) and
[BullMQ connection guide](https://docs.bullmq.io/guide/connections).

## Checks

```powershell
npm run typecheck
npm test -w @rea-studio/pipeline
$env:PIPELINE_TEST_REDIS_URL='redis://127.0.0.1:6380'
npm run test:integration -w @rea-studio/pipeline
$env:PIPELINE_TEST_ORIGIN='http://localhost:3104'
npm run test:http -w @rea-studio/pipeline
```

The HTTP test requires the running local web app, Redis and real Docker worker.
It uploads only generated public fixtures and refuses non-loopback destinations.
It covers a fresh archive, cached duplicate, wrong hash, missing/wrong access,
repeated completion, cross-origin requests and a malformed archive failure.
CI runs storage/unit tests, real Redis queue checks and the existing real Docker
tests; HTTP/browser checks are currently local.
