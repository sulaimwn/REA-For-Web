# Upload pipeline (T007, T025, T032, T048)

The browser hashes an .asar, .exe, .dll, .apk, .elf, .so, .macho or .dylib file in 4 MB chunks, requests a signed upload ticket,
uploads it, and explicitly completes the upload. Redis/BullMQ holds the job until
a separate trusted worker downloads and verifies its size and SHA-256. The worker
calls the existing Docker sandbox and stores only compressed StudioProject JSON.
The uploaded target is never executed. Storage and Redis credentials never enter
the analysis container or browser.

The form separates file preparation from transfer. Its upload percentage and
byte count come from browser transfer events; 100% still waits for the server's
successful response. The job page then shows queue and analysis stages with
REA's progress text. Analysis has no invented completion percentage.
The homepage and upload page read service availability at request time. Without
the configured service, the upload page offers local analysis instead of a form.

## Try it locally

With Docker Desktop running, from the repository root:

```powershell
npm ci --ignore-scripts
npm run dev:uploads
```

Open http://localhost:3104/upload and choose an application file (up to 512 MB).
The helper builds the web app and both analysis images, starts a Redis container bound
to 127.0.0.1:6380, and runs the web app and trusted queue worker. Ctrl+C stops its
services. Use UPLOAD_DEV_PORT / UPLOAD_REDIS_PORT if those ports are occupied.
Alternate Redis ports use their own persistent volume; the default port keeps the original volume.
The helper defaults to `REA_NATIVE_WORKER=1` for Ghidra/JADX support. Set it to `0`
to build/run only the smaller image (.NET and Electron); native programs, ELF, Mach-O and APKs then fail clearly.

Linux executables often have no extension. Rename the file to end in `.elf`
before uploading; versioned library names such as `libnotes.so.1` must end in
`.so` or `.elf` for this explicit upload path. The worker checks the actual ELF
header inside the sandbox; an extension alone does not make a file valid.

For macOS, upload a single-architecture Mach-O program as `.macho`, or a library
as `.dylib`. Rename an extensionless program first. The worker checks its actual
thin Mach-O header; universal binaries, `.app` directories, `.ipa` archives and
versioned `.dylib.1` filenames are outside this path. For an app bundle, use its
thin executable from `Contents/MacOS/`. Full macOS verification currently covers
x86_64 jq and its filename aliases, not every architecture or a real dylib build.

Local objects and the signing secret live in gitignored `.pipeline-data/`;
private staging is in `.pipeline-work/`. Redis uses the named Docker volume
`rea-studio-upload-redis` with append-only persistence and no eviction. This is
local development, not a filesystem storage option for serverless deployment.
Keep both directories private to the service account. The signing secret is
generated once and never logged.

On a native Linux host, run the upload helper and queue as UID 1000. The sandbox
uses that UID to read private mode-0600 inputs. The helper rejects a different
effective UID before writing local data, building images or starting services.
Windows and macOS Docker Desktop users are unaffected. See the account setup in
[hosted uploads](hosted-uploads.md); do not loosen file permissions or renumber
an existing account to get around the check.

## API

- POST /api/uploads, JSON `{name, bytes, sha256}` → `{jobId, jobToken, uploadUrl,
  headers, expiresAt}`. Names must end in .asar, .exe, .dll, .apk, .elf, .so, .macho or .dylib (case-insensitive).
  Request/response fields are unchanged; unknown request fields are discarded.
- PUT the file bytes to uploadUrl, with the returned headers. A ticket expires
  after ten minutes. The local endpoint verifies bytes before publication; R2
  signatures bind Content-Type and Content-Length, and the worker independently
  verifies every downloaded byte.
- POST /api/uploads/:id/complete with `Authorization: Bearer <jobToken>` queues
  the uploaded object. Completion is idempotent. Requests from the browser must
  have the configured Origin; R2 mode additionally requires X-REA-Access-Key.
- GET /api/jobs/:id with that bearer token → awaiting-upload / queued / running /
  succeeded / failed, the authorized job's optional uploadName, REA progress
  text, and projectId/cacheHit on success.
- GET /api/jobs/:id/project with that token streams compressed StudioProject
  JSON (Content-Encoding: gzip); ordinary fetch transparently decompresses it.

Job access expires after 24 hours. Tokens are kept in sessionStorage, never in
URLs. A result URL can be reloaded in its uploading tab; opening it in a different
browser session requires uploading the app again. There is no public hash lookup.
The server admits at most 100 upload tickets per UTC day for the private beta.

R2 downloads have one 60-second deadline covering request retries, response
headers and the complete body. A stalled result download fails instead of
leaving the viewer loading indefinitely; the authorized tab can reload to try
reading its stored result again. A stalled raw-file download fails the analysis
job before the analyzer runs, then cleans raw data and local staging as usual.

## Cache identity and retention

The uploaded file SHA-256 is separate from REA's subject/project id. Cache keys
include schema 0.1.0, REA 6.4.0, adapter/cache revision 7 and the analysis file kind. Increment the cache revision
when adapter semantics or analysis settings change. Cache reuse happens only
after the worker has downloaded and verified a fresh upload with the same hash.
This proves possession before exposing a cached result.
Different file kinds have separate cache paths. A PE uploaded as .asar must reach
ASAR validation rather than reuse a cached .exe result with the same hash.
Both `.elf` and `.so` use the canonical `elf` kind and may reuse each other's
verified result for identical bytes. PE, ASAR and APK results remain separate.
Both `.macho` and `.dylib` use canonical `macho`, with a separate result namespace
from ELF, PE, ASAR and APK. Their bytes are verified before any cache lookup.
These added namespaces keep revision 7's existing parser/cache semantics, and
existing authorized results remain readable.

Cached projects use a canonical `target.<kind>` fallback name, never another uploader's
filename. The viewer applies its own authorized uploadName when the app has no
artifact package/assembly name; a recovered name still takes precedence. Older authorized
ASAR jobs from cache revisions 2–6 remain readable. Terminal queue states reload the
job record before returning a result, including very fast cache hits.

Analysis concurrency is globally one per queue. A job is acknowledged as complete
only after result storage and raw-object/staging cleanup finish. Deterministic
analysis failures are not retried automatically. Worker crashes are marked failed
on stalled-job detection. Each sandbox requires a private liveness signal before
analysis, then receives one every five seconds. A disconnected owner stops the
container and its parser descendants; an attached client that stops sending the
signal is stopped after 20 seconds. The whole-job deadline remains in force.
This prevents a crashed process's sandbox from overlapping its replacement job.
Raw files and staging left by a hard crash still use the 24-hour expiry backstop;
normal failures and cancellations perform immediate cleanup. A stopped orphan
container may remain as Docker metadata until the operator removes it.
Normalized results stay in the private cache. Raw uploads and abandoned staging
older than 24 hours are swept at worker startup and hourly while it runs.
Queued records older than 24 hours are rejected before analysis.

Analysis has a 15-minute whole-job deadline, enforced by both the host and the
container. On slower machines the operator can set `REA_ANALYSIS_TIMEOUT_MS`
on the trusted queue worker (1,000–1,800,000 ms; maximum 30 minutes). Upload
requests cannot change it. CPU, memory, file and output caps still apply.
`REA_ANALYSIS_CPUS` (0.1–4, default 1) sets the CPUs each job's container gets.
Program analysis runs Ghidra on the JVM, which one CPU starves. jq 1.8.2 (macOS)
took 124–145 s on 1 CPU, 52–57 s on 2 and 42 s on 4, with identical results.
APK (JADX) timings varied too much to conclude: Binary Eye took 90–165 s on 1 CPU,
109–162 s on 2 and 74 s on 4. Jobs run one at a time, so 2 suits a 4-vCPU host
and leaves room for the website and Redis.
APK admission checks its bounded ZIP directory and caps both its entry count and
declared expanded bytes. Its individual class/method collection also has caps,
and missing method bodies remain visible as partial analysis.
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

## Pre-analyze popular app files

An operator can prepare private results before visitors upload a popular release.
The tool uploads a local copy through the normal signed-upload and queue path.
It never imports a demo graph, skips byte verification, or writes a cache key
directly. The existing worker runs with its existing CPU/memory/deadline limits,
and global concurrency remains one. Each run uses the existing daily ticket quota.

Build the packages, then load the **same private worker environment** and point
the tool at one application file:

```sh
npm run build:packages
node --env-file=/etc/rea-for-web/worker.env scripts/preanalyze-cache.mjs /srv/app-files/App.asar --sha256 <recorded-release-sha256>
```

For a local configured environment, `npm run cache:seed -- "path/to/App.asar"`
builds the packages before running the tool. Configuration must already be
loaded into that process; npm does not load the web app's environment file.
Local storage mode needs Redis and the queue worker, but no running web server.
Hosted mode streams the file to the configured private R2 bucket using its
generated signed URL. It does not follow upload redirects. No upload URLs,
tokens or storage credentials are printed or supplied as command-line flags.

`--sha256` is optional, but recommended to ensure the exact expected app release.
A mismatch fails before admission/upload. Use complete shipped files; a demo
created from a subset, such as the VS Code core demo, must not seed an entire
app's hash. Linux files still need an admitted `.elf`/`.so` filename.

When the command reports that the private cache is ready, later uploads of the
**exact same bytes and analysis kind** can reuse it after download and byte
verification. Other versions and parser kinds still need their own analysis.
The normal worker removes raw bytes and staging on completion/failure. Ctrl+C
stops waiting; an already queued job continues and owns its cleanup. If queue
completion loses its response, the tool keeps the raw file for the worker or
expiry sweep, since that job may already be queued.

This is preparation for a configured service, not a deployed cache. The free
Cloudflare demo website and private upload cache remain separate.

## Connect Cloudflare R2 later

The provider-independent Linux web/queue setup is in
[hosted uploads](hosted-uploads.md). It is a deployment kit, not a live service.

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
- Build both worker images and set `REA_NATIVE_WORKER=1` on the trusted queue
  service to analyze native Windows/Linux/macOS programs and Android APKs. .NET works in the
  standard image. Upload requests cannot choose an image or resource limits.

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
It also uploads the public .NET EXE/DLL, native EXE and Android APK fixtures,
checks their normalized facts and duplicate results, and rejects a cached PE
renamed to ASAR. The Linux fixture also checks a fresh `.elf` analysis, `.so`
alias deduplication, missing authorization, and refusal of PE bytes renamed to
either ELF extension or ELF bytes renamed to PE. Those checks require the native queue setting/image.
CI runs storage/unit tests, real Redis queue checks and the existing real Docker
tests; HTTP/browser checks are currently local.

The separate macOS HTTP check uses the public [jq 1.8.2 release](https://github.com/jqlang/jq/releases/tag/jq-1.8.2)
file `jq-macos-amd64` (SHA-256
`e94b266e3c26690550006abe63152b782280f4e14374accdf04cbde844f00bc0`).
Set `PIPELINE_TEST_MACOS_FILE` to your local copy and use a stack with fresh,
isolated storage and the native image:

```powershell
$env:PIPELINE_TEST_ORIGIN='http://localhost:3104'
$env:PIPELINE_TEST_MACOS_FILE='C:\path\to\jq-macos-amd64'
npm run test:macos -w @rea-studio/pipeline
```

This checksum-gated, loopback-only test requires a real fresh analysis, private
result access and progress, verifies `.macho`/`.dylib` alias cache reuse, and
rejects hash-only possession, wrong bytes, cross-format renames and a universal
header. No download occurs in the test; the supplied program is never executed.
