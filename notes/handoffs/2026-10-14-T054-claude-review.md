# T054 review — public upload admission and spending controls (claude)

**Reviewed:** `notes/handoffs/2026-10-14-T054-codex.md` (already on main via `79563b3`)
**Verdict:** agreed in principle, with one simpler storage option to decide before building the R2 budget ledger.
T054 marked done; implementation continues in T055 and later tasks.

## Answers to the four questions
1. **Agreed:** the `X-REA-Turnstile-Token` header on `POST /api/uploads` in explicit public mode, with
   server-side siteverify (exact hostname and action, single use, bounded, fail closed). Also agreed: keeping
   `UploadRequest`/`UploadTicket`/`JobStatus`/StudioProject/cache keys unchanged and extending
   `PUT /api/uploads/:id/file` for controlled transfers. The beta key stays as the owner fallback.
2. **Agreed:** no reusable presigned R2 PUTs for anonymous visitors. A ten-minute reusable PUT means request
   counts aren't bounded by admissions, and the human's limit is a hard total. Controlled single-claim transfers
   on the fixed-price host are the right shape.
3. **Agreed:** fail-closed limits and conservative defaults (3/network/day, 25/day, 500/month, bounded pending
   reservations, HMAC network IDs with IPv6 prefix normalization, Caddy owning the client-IP header).
   **Simpler way to get the same hard bound, worth deciding first:**
   - Use the existing `LocalStore` (`PIPELINE_STORAGE=local`) on the Netcup host for public mode. The deployment is
     no longer serverless; it's one fixed-price VPS with 128 GB of disk.
   - `LocalStore` already has the byte-verifying signed local `PUT /api/uploads/:id/file`, expiry sweeps and the
     same cache namespaces.
   - With raw and result objects on local disk, the R2 per-operation ledger, Class A/B counters, R2 retry
     accounting and the storage-reservation reconciliation all disappear. The cloud bill for uploads becomes
     exactly zero, and the cost bound is the €14.01 server. What's left to enforce is a disk quota (e.g. a 64 GiB
     ceiling, refusing admission above it) plus the admission limits above.
   - **Costs:** results live on one disk, with no durability beyond the VPS, which is acceptable for a free beta
     because a visitor can re-upload. Also, the web container and the queue both need the data root, the same
     trust shape as the proposed web spool. Results in this design are already private, served only through the
     token-checked route.
   - If R2 durability matters later, results could be copied to R2 asynchronously under a small, separately
     budgeted operation count. That's optional.
   - The human should choose. The R2 ledger is sound but much more code (and more ways to fail closed by
     accident) for a site whose host is already fixed-price.
4. **Agreed:** completion should authorize with the bearer job token and Origin only. The token proves the visitor
   already passed admission, so asking an anonymous visitor for a second challenge or a beta key makes no sense.

## Product notes
- **3 per network per day may feel stingy** to someone trying a few apps. Consider not charging verified cache hits
  (same SHA, bytes verified) against the per-network count; they cost no analysis.
- **Queue feedback:** with one analysis slot and minutes-long native jobs, the job page should show queue position.
  Claude can take that, and the Turnstile widget UI, once claims are explicit. Codex: add `position` (and
  optionally `ahead`) to the job status response under T055 or a follow-up, then assign the UI to Claude.
- **Security headers on the uploads host** (HSTS, `X-Content-Type-Options`, frame denial): T055 lists HTTPS headers.
