# T056 review — public hosted disk uploads, release 1 (claude)

**Branch reviewed:** `codex/T056-public-disk-uploads` @ `1aadb0d`
**Verdict:** approved and merged into main with `--no-ff`. T056 marked done. Deployment is T058 (Codex).

## What I checked
- **Fail-closed config:**
  - `PIPELINE_PUBLIC_UPLOADS=1` requires `PIPELINE_HOSTED_LOCAL=1`, which requires `PIPELINE_STORAGE=local`, an HTTPS
    origin and a 32+ character owner key. Public mode also requires visitor limits (secret plus trusted proxy).
  - Turnstile requires public mode and refuses Cloudflare's test keys. Flag values must be `0` or `1`.
- **Disk bound (`hosted-storage.ts`):**
  - Only an ext4 filesystem of at most 64 GiB, private to the service user (mode 700, owner uid), is accepted.
  - Admission refuses while free space is below 13 GiB, the room for 20 pending maximum transfers plus results.
  - Results are capped at 128 MiB.
  - The hard bound is the filesystem itself, not a resettable ledger.
- **Single-use transfers:** the file route verifies the HMAC upload link **before** the atomic Redis claim, so a
  forged link can't burn a visitor's claim.
  - The claim marks the link used for 24 h and allows at most two active transfers. The body deadline is 10 min.
  - On failure the partial file is removed (base `LocalStore`) and the slot plus the pending lease are released.
    A retry needs a new ticket.
- **Who may upload:**
  - Public admission: Origin plus the network identity (plus Turnstile when enabled).
  - A valid owner key is `owner: true` and skips only the per-network limit; global day/month and pending caps
    still apply. A wrong key gets a clear 403 instead of silently falling back.
  - Completion in public mode: Origin plus the private bearer job token. Results stay token-private.
- **Proxy:** Caddy allows 512 MiB only on `PUT /api/uploads/<uuid>/file`; everything else keeps 1 MB. The socket-peer
  IP header and HSTS/nosniff are kept.
- **My own checkout** (detached at `1aadb0d`):
  - Root typecheck passes. **Pipeline 38/38, web 32/32.**
  - On my own Redis 127.0.0.1:6599 (removed afterwards): **`test:admission` 7/7, `test:integration` 4/4,
    `test:redis-api` 4/4**.
  - **`test:upload-proxy`** passes. Web production build passes.

## Product follow-up (the human asked for much less restrictive limits)
The public ceilings (3/network/day, 25/day site-wide, 500/month) were sized in T054 for an **R2 bill**. With the
human's Option B (local disk), abuse costs nothing extra. The real constraints are:
- analysis time, with one slot and typical jobs of seconds to a few minutes;
- disk, which is already hard-bounded at 64 GiB and kept above 13 GiB free.

25/day site-wide will run out within minutes of any attention. I recommend raising them before or right after go-live,
for example **10/network/day (keep 5/hour), 300/day site-wide, 5,000/month**. The 20-slot pending cap and the
"busy" message already protect the queue. These are constants in `admission.ts` (`hosted ? 25 : 100`,
`hosted ? 3 : 15`, the monthly `500`); making them operator settings would be even better.
