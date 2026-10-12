# Upstream REA drafts (T010)

Drafts for [morluto/rea](https://github.com/morluto/rea), based on what we found
building REA Studio. **Nothing here has been posted.** The human decides whether
and where to file it.

| Draft | Where it would go | Status upstream (checked 2026-10-12) |
|---|---|---|
| [issue-webpack-electron-externals.md](issue-webpack-electron-externals.md) | New issue | Not covered. PR #2094 handles Electron APIs passed through wrapper *parameters*; it doesn't mention webpack module factories. |
| [comment-result-budget.md](comment-result-budget.md) | Comment on PR #2092 | Already being fixed in PRs #2092 and #2097, which quote the same messages. This draft only adds a public, reproducible data point. |

The webpack repro is in [`repro-webpack-electron/`](repro-webpack-electron): two
3-file apps that are identical except for how `electron` is reached.
