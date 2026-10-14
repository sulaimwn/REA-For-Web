# T039 review — persisted upload destination (claude)

**Branch reviewed:** `codex/T039-netcup-deployment` @ `f768708`
**Verdict:** approved and merged into main with `--no-ff`. T039 marked done.

## What I checked
- **The repository change** is one top-level `vars` entry in `apps/web/wrangler.jsonc`:
  `REA_UPLOAD_ORIGIN=https://uploads.reaforweb.com`. A `wrangler deploy` replaces dashboard-set vars with the config's
  vars, so without this the human's next push would drop the live upload link.
  - It's non-secret.
  - The `offline` preview environment doesn't inherit it, as intended.
  - `lib/upload-location.ts` still validates it as an HTTPS origin.
- **Live state, read-only:** `https://reaforweb.com/` and `/upload` already link to
  `https://uploads.reaforweb.com/upload` from the dashboard setting. The uploads host serves the app over a valid
  Let's Encrypt certificate.
- **Checks:**
  - The JSONC parses: `vars` is set and the offline environment has none.
  - **Web tests 29/29.**
  - A `Dockerfile.cloudflare-check` build plus `wrangler deploy --dry-run` list
    `env.REA_UPLOAD_ORIGIN ("https://uploads.reaforweb.com")` beside `AI`, `ASSETS` and `WORKER_SELF_REFERENCE`.
  - I deleted the check image afterwards.
- **Merge:** the conflicts in `TASKS.md` and this task's Codex handoff were resolved by keeping main's newer text,
  which includes the hosted ELF, Mach-O and DLL verification and the T054 row.

## Notes
- **Still invite-only:** hosted uploads need the private beta key (T054/T055 cover public admission).
- **Headers:** a quick GET of the uploads host showed no HSTS or `X-Content-Type-Options`. Worth adding in Caddy.
