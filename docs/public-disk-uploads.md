# Public uploads on the paid VPS (T056)

First release: no invitation or bot check required for a visitor. Public access
is explicit/default off and requires HTTPS, the dedicated trusted Caddy proxy,
network quotas and bounded disk storage. The owner's existing private key may
skip the per-network limit; it never skips global or disk limits. Uploaded
targets still reach only the existing static REA Docker sandbox.

Admission limits are **3 tickets/network/UTC-day, 25 site-wide/UTC-day and 500
site-wide/UTC-month**. They count tickets, including unsuccessful uploads; a hash
claim is not proof of possession. The existing 20 total pending slots remain.
At most two file transfers run at once; a signed capability is consumed once,
even if the transfer fails. A new attempt needs a new ticket. Transfers time out
after ten minutes and remove partial files. Completion still requires the private
job token and exact Origin, with no second invite or challenge.

The later bot-check release enables `PIPELINE_TURNSTILE=1` with real Cloudflare
widget keys. When enabled, a visitor's fresh token is verified server-side with
exact hostname/action and a five-second header-and-body deadline. Test keys are
rejected in hosted configuration. The client loads the widget only after hashing,
uses a fresh check on each attempt and removes it on cancellation. The secret is
never passed to the client; the server supplies only its public site key. Leaving
this flag off does not call the vendor or download its script.

## Bounded storage and migration

`PIPELINE_STORAGE=local` plus `PIPELINE_HOSTED_LOCAL=1` is the production mode;
ordinary local development still refuses a non-loopback origin. This production
mode accepts only a private ext4 filesystem with **at most 64 GiB capacity**,
owned by the service's UID with no group/world permissions. A normal 128 GiB root
filesystem or a RAM-backed tmpfs fails closed. Put raw uploads and results on
that volume; the worker staging directory stays separate.

Admission stops below **13 GiB free** (maximum pending input/result headroom,
including a margin). Result publication is capped at 128 MiB plus bounded
metadata. The filesystem itself is the final byte ceiling; resetting Redis cannot
enlarge it. This avoids a cloud storage/operation bill for anonymous uploads.
It cannot stop abuse from using the daily allowance or guarantee uptime. Existing
VPS, domain and other project costs still apply. No new paid plan/autoscaling.

Administrator rollout, after independent review:

1. Check active/waiting jobs and drain them; keep the current R2 release and
   private environment backups for rollback. Do not interrupt a visitor's analysis.
2. Check the host has room for 64 GiB of actual future allocations plus the OS,
   images and staging. Create a **new**, explicitly named sparse image
   `/var/lib/rea-for-web/objects.ext4` of 64 GiB, owned by root/mode 600, only if it
   does not exist. Format that new file ext4 with `mkfs.ext4`; never format an
   existing image, device or data directory. Leave the root disk partition alone.
3. Install `rea-upload-objects.mount.example` under the escaped mount-unit name:
   `systemd-escape --path --suffix=mount /var/lib/rea-for-web/objects`.
   Use the empty dedicated mount point, enable the unit and verify with `findmnt`
   that the exact image is mounted ext4 with loop/nosuid/nodev/noexec. Set the
   filesystem root to UID/GID 1000, mode 700. Verify its measured capacity <=64 GiB.
4. Copy existing private R2 result objects **and their S3 metadata** into matching
   paths and `.meta` sidecars on the new volume. Validate every path against the
   pipeline storage-key grammar; preserve private permissions. No result or R2
   object is deleted by migration. Confirm old job tokens can read the copied maps.
5. Install the reviewed source and web image. Keep analysis image/source ownership
   protocol aligned with T053. Switch both private env files using the local examples,
   keeping origin/prefix/owner key/upload secret consistent. The web has network
   quota settings; the worker does not need widget or R2 credentials. Initially
   `PIPELINE_PUBLIC_UPLOADS=0`; keys and env files stay root-owned outside Git.
6. Apply both `compose.yml` and `compose.local.yml`; the web gets only the object
   volume, never Docker or staging. Preserve loopback web/Redis ports, read-only
   root, non-root UID, memory/PID limits and capability drops. The web log is bounded.
   Install `worker.local.conf.example` as the queue service's local-storage drop-in
   and reload systemd. It adds the object volume to `ReadWritePaths` and requires
   the mount, preserving the existing service hardening and staging permission.
7. Run host preflight, test a private disk upload and old private result reads.
   After review, enable `PIPELINE_PUBLIC_UPLOADS=1` on the web. Keep
   `PIPELINE_TURNSTILE=0` for the first launch. Verify a real visitor upload from
   the main website with no key, private result access, quota refusals, signed-link
   replay rejection, transfer cancellation and zero raw/staging/analysis leftovers.

The upload host/Cloudflare destination stays the same, so no new DNS or frontend
origin change is needed. Migration changes deployment storage only. Retained
results live on this one VPS; visitors can re-upload after a loss. Existing raw
deletion/expiry remain. Retained results are not purged automatically: when the
volume is full, new admission stops.

Rollback: disable public admission, restore the previous private env/release and
base Compose without the local overlay, and restart the private R2 service. Preserve
the local volume and its results; public jobs using disk results need that release
or a separate copy back to R2 to remain readable. Never unmount a volume with
active writers, delete cached results or revoke the storage key as a side effect.
