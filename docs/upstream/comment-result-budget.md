# Draft comment for morluto/rea PR #2092 (and #2097)

Another data point, on a public app anyone can reproduce: **GitHub Desktop 3.6.5**
(open source, MIT), unpacked app directory (`resources/app`, 1,059 files, 383 MB,
260 relevant files), `rea-agents@6.4.0`, Node 24.18.0, Windows 11.

`rea analyze-javascript-application <app> --format json` (default limits):

- exit 0, 82 s, 50.2 MB output, ~1.5 GB peak RSS across the process tree
- **139 of 156** `javascript-asset` nodes carry `application_projection_failure:
  resource_constraint` ("Expanded application relationships for … exceed the parent's
  result budget"); others say "The parent reserved its remaining result capacity for
  static observations; semantic analysis of … was not started"
- reported limits: `javascript_analysis_parent_result_budget_bytes: 2058631436`,
  `javascript_analysis_semantic_result_budget_bytes: 0`. A failing file reports
  `application_projection_required_bytes: 2916064` (main.js)
- `--max-heap-mb 4096`: 255 s, ~4.8 GB peak, same failures (no improvement)
- **`main.js` analyzed alone** (copied with `main.js.map` and `package.json` into an
  empty directory): 9.6 s, **0** projection failures

So in the whole-app run, files lose their relationships depending on what was
admitted before them, not on their own size. That matches the analysis in this PR.
Glad to rerun on the PR branch against this app if useful.
