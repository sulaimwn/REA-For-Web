# T055 review — upload admission guards (claude)

**Branch reviewed:** `codex/T055-upload-admission-guards` @ `77b663f`
**Verdict:** approved and merged into main with `--no-ff`. T055 marked done. Not deployed; the beta gate stays.

## What I checked
- **Diff read:** `admission.ts`, the `server.ts` create/complete changes, `uploads-server.ts`, the route, the Caddyfile,
  `web.env.example`, docs and tests.
  - **One atomic Lua reservation** enforces the 100/day global budget, 20 pending slots (expiring ticket leases plus
    BullMQ wait/paused/active lists and delayed/prioritized/waiting-children sets), and the optional per-network
    5/hour and 15/day limits. Counters increment only after every check passes. Redis `TIME` sets lease expiry.
  - **Completion** excludes its own entry, reacquires capacity if the lease expired, holds a non-expiring entry
    across the queue add, then removes it. A retry with the same token releases it if the job exists.
  - **`networkIdentity`** validates with `isIP` and rejects zone IDs. It expands IPv6 including embedded IPv4, groups
    /64s and folds IPv4-mapped addresses into IPv4. Only HMAC digests reach Redis.
  - **Caddy** overwrites `X-REA-Client-IP` from `{remote_host}`. Deferred headers force HSTS (1 year) and
    `nosniff` over upstream values, and the 1 MB metadata cap is kept.
  - **Messages:** only the queue-busy 503 message is shown to visitors; other 503s stay sanitized.
- **My own checkout** (detached at `77b663f`): root typecheck passes, **pipeline 30→33/33**, **web 29/29**.
  - On my own disposable Redis 127.0.0.1:6598 (removed afterwards): **`test:admission` 5/5, `test:redis-api` 4/4,
    `test:integration` 4/4**.
  - **`test:upload-proxy`** passes with the pinned Caddy: forged IP overwritten, headers enforced, metadata limit
    kept. No leftover containers.

## Must-change for the agreed public mode (the human chose local VPS storage, Option B)
1. `configFromEnv` currently refuses visitor limits unless `mode === 'r2'`. The local hosted mode needs this relaxed.
   Require the trusted dedicated proxy and secret instead of R2.
2. In local mode, file bodies go through `PUT /api/uploads/:id/file`. Caddy's 1 MB `request_body` cap must allow the
   bounded upload size on that exact route only, as T054 planned.
3. Apply the T054 public ceilings (3/network/day, 25/day, 500/month) when public mode is on, alongside the disk quota.

## Suggestion
- **Automatic cleanup of leaked completion slots:** a crash between `queue.add` and `zrem` leaves a non-expiring
  `admission-pending` entry, and every leak removes one of the 20 slots for good. Because job ID equals upload ID,
  this can be cleaned up safely and automatically:
  - remove the entry if `queue.getJob(id)` exists in any state;
  - remove it if the upload record has expired (24 h), since no delayed queue write can arrive that late.
  - The worker could do this in its existing hourly sweep.
