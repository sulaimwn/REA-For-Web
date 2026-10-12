# T005 / T010 / T011 — Codex cross-review

**Reviewed branch:** claude/T011-launch-prep at 1765de1
**Review branch:** codex/T011-review
**Status:** passed, with two small fixes included

## Review findings and fixes
- Inspector previously stopped at 20 evidence records with a noninteractive remaining count. Added a Show more evidence button in batches of 20, with state reset per node.
- Keyed Explorer by demo slug to reset project, selection, focus and URL restoration when the route changes between demos.
- No StudioProject schema or adapter changes. No upstream issues posted or deployments performed.

## Verification
- Fresh locked dependency install succeeded.
- Workspace typecheck, adapter 27/27, worker 31/31 and root production build passed.
- Production browser check: tiny-electron search for notes:save selects the channel and its neighborhood; reloading the generated URL restores the inspector with both real evidence locations.
- GitHub Desktop browser check: the partial-analysis banner is visible, and external-module:path has 89 evidence records; Show more increases displayed evidence from 20 to 40. No browser console errors recorded on these checks.
- Upstream PR bodies 2092, 2094 and 2097 verified through the official GitHub API; the draft distinction between Electron wrapper parameters and webpack factories is consistent with those descriptions.
- Vercel deployment recipe remains explicitly untested; cloud deployment requires account setup.

## Next
- Merge this reviewed branch into main, retaining T004 and T006 done, and T007 todo.
- Codex proceeds with T007. Cloudflare R2 credentials and production deployment are not present; local development and an explicit storage boundary will let us test before account setup.
