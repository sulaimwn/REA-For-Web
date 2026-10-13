# T037 independent launch review (Codex)

Reviewed `claude/T037-launch` at `123369f`, integrated with current main on
`codex/T038-launch-readiness`. Approved for merge.

- Read every source/document change and Claude's handoff. The SVG is a standalone
  local image with no external resources or scripting. Viewed the 180 px Apple icon.
- All eight workspaces typecheck. Website tests: 24 pass, no failures/skips.
- Production Next build passes and generates 18 pages including the new icon routes.
  The first restricted Windows build failed to create a directory junction; rerunning
  the same build outside that restriction passed without source changes.
- Own loopback production preview: homepage, favicon, SVG, Apple icon, `/open`,
  `/upload` and `/explore/binary-eye` all return 200 with the expected content types.
- Updated only the domain instructions to match the actual Cloudflare dashboard
  now visible: Domains tab → Add Domain → select existing zone → optional subdomain.

Live account work belongs to T038. At review time, the existing `reaforweb` Worker was serving an
older reviewed release (`cbce4df` on remote main). Added the existing `reaforweb.com`
and `www.reaforweb.com` domains through the dashboard; both now appear as Production
domains on that Worker. Public HTTPS verification and the human's next main push
were still pending. They are now verified after the human pushed `898f17c`; see
`2026-10-13-T038-codex.md`. No credentials, hosting purchase, AI binding or
repository push by Codex.

Free Ask stays disabled until the actual Workers plan and the pending conversation
budget correction are verified. Hosted uploads need the separate analysis host and R2.
