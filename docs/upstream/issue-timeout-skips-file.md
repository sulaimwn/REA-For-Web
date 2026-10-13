# Draft issue: let a per-source timeout skip that source instead of stopping the analysis

**Where:** new issue on morluto/rea. **Not posted.** Upstream status not checked yet; search the issues first.

---

**Title:** `analyze-javascript-application`: option to skip a source that exceeds `--analysis-timeout-ms` and continue

`--analysis-timeout-ms` is documented as the "maximum startup, analysis and transfer time per
JavaScript source". When one source exceeds it, REA "return[s] collected partial Evidence and
stop[s] the analysis". That's the safe default. But real Electron apps ship a few very large
vendored libraries, and those dominate analysis time while saying little about the app's own
architecture.

Measured with rea-agents 6.4.0 on Obsidian's `obsidian.asar` (27 MB, 38 sources), 1 CPU, Linux:

| What | Time |
|---|---|
| Whole app | 458 s |
| `app.js` (the app itself) | ~60 s |
| `lib/mermaid.min.js` (2.96 MB, vendored) | 40 s alone |
| `lib/i18next.min.js`, `lib/defuddle.full.js`, PDF.js, CodeMirror | most of the rest |

Heap size barely matters (37–40 s for Mermaid at 1–3 GB), and neither do extra cores (34 s with 4 CPUs).
A lower timeout today ends the whole run at the first big library, so every later source is lost.

**Request:** an opt-in mode, e.g. `--source-timeout-policy skip` (default `stop`):
- A source that exceeds the per-source timeout is recorded as an explicit unknown (`partial`, with the
  timeout as its reason), like other dropped sources.
- Analysis continues with the remaining sources, and whole-app correlation still runs on what was analyzed.

Alternatives that would also work:
- a byte-size threshold above which sources are inventoried but not parsed;
- a caller-supplied list of paths to inventory only.

Either way, the result stays honest about coverage, and callers can bound analysis time for big apps.
