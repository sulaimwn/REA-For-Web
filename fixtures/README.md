# REA fixtures (T001)

Real output from REA's static JavaScript/Electron analysis, plus notes on what
it does and doesn't give us. **Build against these files, not against the REA
README.**

## Pinned version

| | |
|---|---|
| Package | `rea-agents@6.4.0` (npm, published 2026-10-11) |
| Node used | v24.18.0 (REA requires ^22.19 / ^24.11 / >=26) |
| Host | Windows 11, measured 2026-10-12 |

## CLI syntax (verified)

```bash
rea analyze-javascript-application <path> --format json
```

- `<path>` is an `.asar` file or an extracted app directory (`--artifact-format auto|asar|directory`).
- `--json` also works but is **not listed in `--help`**; `--format json` is the documented form.
- JSON result → **stdout**. Progress → **stderr** as one JSON object per line:
  `{"rea_progress":{"phase":"...","message":"Parsing and projecting main.js (2/260)","terminal":true?,...}}`.
  Usable directly for a progress bar.
- Useful flags: `--max-heap-mb` (default 1024), `--analysis-timeout-ms` (default 300000 per source),
  `--integrity-policy fail|record-and-continue`.
- Nothing is executed: REA parses JS/HTML as inert text (stated in its limitations).
- Output is deterministic: two runs on the same input were byte-identical → caching by file hash works.
- Related commands we'll want later: `compare-application-versions` (version diff),
  `inspect-analysis-view` (project a view of a completed result).

## Files

| File | What it is |
|---|---|
| `sample-apps/tiny-electron/` | Hand-written 7-file Electron app with a known `GROUND_TRUTH.md`. Never run. |
| `samples/tiny-electron.rea-6.4.0.json` | **Complete, untrimmed** REA output for the tiny app (0.6 MB). |
| `samples/tiny-electron-asar.rea-6.4.0.json` | The same tiny app packed as `sample-apps/tiny-electron.asar` (with `@electron/asar`), complete REA output. Adds `asar-entry` nodes; otherwise identical. |
| `samples/github-desktop-3.6.5.trimmed.rea-6.4.0.json` | GitHub Desktop 3.6.5 (open source, MIT) output, **trimmed** from 50 MB to 7 MB. |
| `samples/vscode-core-1.141.0.trimmed.rea-6.4.0.json` | VS Code 1.141.0 core subset (`package.json`, `out/main.js`, `out/mainImpl.js`, 3 preload scripts; no source maps shipped). App graph complete (149 nodes, 292 edges); only the semantic graph is trimmed (28.7 MB → 2 MB). |
| `tools/measure.ps1` | Runs REA and records time, sizes, gzip size, peak process-tree memory. Set `REA_MJS`. |
| `tools/shape.mjs` | Prints JSON structure with byte share per key. |
| `tools/render.mjs` | Prints the application graph as readable `node --relation--> node` lines. |
| `tools/trim-fixture.mjs` | Trimming used for the GitHub Desktop sample. |
| `tools/scrub-paths.mjs` | Replaces absolute local paths with `<INPUT_PATH>`. |

**Trimming / scrubbing (both sample files):** absolute input paths were replaced
with `<INPUT_PATH>`. The GitHub Desktop file additionally keeps every non-module
node (Electron, IPC, native add-ons, storage, endpoints, unknowns), up to 600
module-like nodes chosen breadth-first from those, only edges whose two ends were
kept, and the first 200 items of each semantic-graph array. Original counts are in
the file's `_fixture_trim` key. Both edits change hashed bytes, so **REA's own
evidence validation will reject these files**. They're fine for adapter and UI work.

To regenerate the full GitHub Desktop output (gitignored under `fixtures/raw/`):
```bash
rea analyze-javascript-application "%LOCALAPPDATA%/GitHubDesktop/app-3.6.5/resources/app" --format json > fixtures/raw/github-desktop-3.6.5.json
```

## Measurements

`fixtures/samples/tiny-electron.timeout.rea-6.4.0.json` is a real REA 6.4.0
response from the same tiny fixture with `--analysis-timeout-ms 1`. It exits
nonzero with `provider_timeout`; `details.partial_observation` contains retained
application Evidence with partial graph coverage and explicit source timeout
gaps. This fixture checks the adapter's opt-in handling of retained timeout
Evidence, including rejection of incomplete cleanup and malformed results.

| Target | Input | Time | Output | Gzipped | Peak RAM (tree) | Result |
|---|---|---|---|---|---|---|
| tiny-electron | 8 files, <0.01 MB | 2.6 s | 0.6 MB | 0.08 MB | 0.4 GB | exit 0, coverage complete |
| GitHub Desktop 3.6.5 | 1,059 files, 383 MB (260 parsed) | 82 s | 50.2 MB | 8.1 MB | 1.5 GB | exit 0, coverage **partial** |
| GitHub Desktop 3.6.5, `--max-heap-mb 4096` | same | 255 s | 50.2 MB | 8.1 MB | 4.8 GB | same failures; **no gain** |
| GitHub Desktop `main.js` alone | 3 files | 9.6 s | — | — | — | 0 projection failures |
| VS Code 1.141.0 | 3,157 files, 638 MB (5,993 sources queued) | stopped at 160 s | — | — | 1.9 GB | 473/5,993 parsed when stopped |

Peak RAM = summed working set of REA's process tree (3 processes), sampled every 200 ms.
VS Code linear extrapolation is ~30+ min; not verified.

## Output structure

```
{ evidence_id, subject{name,digest.sha256,format,local_path}, provider, operation,
  parameters, confidence:"derived", authority:"shipped-artifact", limitations[],
  normalized_result: {
    summary{...}, statistics{...}, limitations[], integrity_contradictions[],
    graph:          JavaScriptApplicationGraph   ← ~23% of bytes; what the map needs
      { nodes[{node_id,kind,identity,observations[]}],
        edges[{source_node_id,target_node_id,relation,properties,evidence,edge_id}],
        coverage{status,truncated,limits[]}, limitations[] }
    semantic_graph: JavaScriptSemanticRelationGraph  ← ~75% of bytes; function-level dataflow
      { nodes[], relations[], unknowns[], fingerprints[], evidence_contexts[], coverage }
  } }
```

- Human-readable names live in `node.observations[0].label` / `.properties`, **not** in `identity`
  (identity is hashes/strategy).
- Every edge and observation carries `evidence`: `state` (`observed` | `inferred`),
  `confidence` (enum: `exact` | `high` | `medium` …, **no numeric score**), `authority`,
  `location` (`{source, start{line,column}, end}`), `extractor`, `coverage`, `limitations[]`.
- The same module (e.g. `electron`) appears as several `javascript-module` nodes, one per
  import site. The adapter must dedupe.

### Node kinds seen
`artifact`, `package`, `javascript-asset`, `javascript-module`, `javascript-chunk`,
`source-map`, `source-module`, `electron-main`, `electron-renderer`, `electron-preload`,
`browser-window`, `context-bridge-api`, `ipc-channel`, `ipc-handler`, `native-addon`,
`endpoint`, `storage`, `worker`, `unknown`.

### Edge relations seen
`contains`, `imports`, `exposes`, `loads`, `maps_to`, `invokes`, `sends`, `handles`,
`calls`, `persists_to`.

## What the output actually supports

| Need | Field(s) | Tiny sample | GitHub Desktop | Explicit vs inferred |
|---|---|---|---|---|
| File/module inventory | `javascript-asset`, `artifact` nodes | ✅ all | ✅ 156 assets | observed/exact |
| Original source tree | `source-map --contains--> source-module` | n/a | ✅ **1,777 files** (1,079 app's own, e.g. `app/src/ui/history/compare.tsx`) | observed |
| Imports between modules | `javascript-module --imports--> …` | ✅ all, incl. ESM in renderer | ⚠️ 374 edges, but almost all in unbundled `copilot/` SDK + node_modules; **0 between the app's own source modules** | inferred/high–medium |
| main / renderer entrypoints | `electron-main`, `electron-renderer` (`package --loads--> electron-main`, `renderer --loads--> asset`) | ✅ | ✅ `main.js`; `index.html`, `crash.html` | inferred/high |
| Preload | `electron-preload`, `browser-window --loads--> preload` | ✅ | — app has none (correct: it uses `nodeIntegration`) | inferred/high |
| BrowserWindows | `browser-window` nodes | ✅ | ❌ 0 found, real count ≥2 (`new r.BrowserWindow(...)` in main.js) | — |
| IPC channels | `ipc-channel` (`properties.channel`, `side`, `operation`, `resolution`) | ✅ 3/3 named | ⚠️ 7 ops found, **all `resolution: dynamic`** (channel passed as a variable) | inferred/high |
| IPC pairing sender ↔ handler | `ipc-handler --handles--> ipc-channel`, `asset --invokes/sends--> ipc-channel` | ✅ 3/3 paired | ❌ 0 paired (REA refuses to pair dynamic channels, by design) | inferred/high |
| contextBridge API | `context-bridge-api`, `asset --exposes--> …` | ✅ `notesApi` | — none in app (correct) | inferred/high |
| Renderer's use of the bridge (`window.notesApi.save()`) | — | ❌ **not linked** | — | missing |
| Native add-ons | `native-addon` nodes | n/a | ✅ 11 `.node` files listed; only 2–3 linked to the code that loads them | observed (inventory) |
| Network endpoints | `endpoint` (`properties.value`, `.mechanism`) | n/a | ⚠️ **2 real of 89**; the rest are `Map.get()` calls misread as HTTP GETs, still marked `confidence: exact` | observed (literal), not semantically checked |
| Storage | `storage` (`storage_kind`, `name`, `mechanism`) | n/a | ✅ 9, real `localStorage` keys | observed |
| Unknowns / gaps | `graph.coverage`, `limitations[]`, `unknown` nodes, `semantic_graph.unknowns` | explicit | explicit (297 limitation strings, 288 unknown nodes) | explicit |

### Limitations found (with causes)

1. **Webpack/minified Electron calls are invisible.** GitHub Desktop's `main.js` does
   `new r.BrowserWindow(...)` and `r.ipcMain.handle(e, ...)` where `r` is webpack's handle to
   `electron`. REA only follows "proven lexical module aliases", so it finds 0 BrowserWindows
   and 0 main-process IPC handlers, **even when main.js is analyzed alone**. Most shipped
   Electron apps are bundled this way.
2. **Shared result budget drops relationships in whole-app runs.** 139 of 156 assets report
   `application_projection_failure: resource_constraint` ("Expanded application relationships …
   exceed the parent's result budget; complete static facts were retained on the file node"),
   with tiny required sizes (e.g. 2.9 MB) against a reported 2 GB budget. Analyzed alone,
   main.js has 0 such failures, and other failures say "The parent reserved its remaining
   result capacity for static observations", so the budget is shared across files. Not
   fixable with `--max-heap-mb`. Possibly worth an upstream issue.
3. **Heap exhaustion on big bundles.** `renderer.js` (3.2 MB), `cli.js`, and `copilot/app.js`
   (8.5 MB) exhausted the analyzer heap during the semantic phase; `renderer.js` is `parse_status: partial`.
   A 4 GB heap didn't fix it.
4. **Endpoint detection is noisy** (see table). Filter on `mechanism` (`call:fetch`, `call:request`, …)
   and on URL/path shape.
5. **Renderer → bridge hop is missing** even in the simple case.
6. **Duplicate module nodes** per import site; labels must be read from observations.
7. **Absence is not proof.** REA says so repeatedly; the UI must show "not found" differently from "doesn't exist".

## Can this support an interactive architecture map?

**Yes for hand-written or lightly bundled apps; only partly for big minified bundles.**

- **Works well:** file and source-tree explorer (source maps recover real file names),
  process roles (main / renderer / preload), the preload ↔ IPC ↔ handler chain when channels are
  string literals, native add-on and storage inventories, and per-item evidence with exact file:line.
- **Weak on real bundled apps:** the import graph among the app's own modules, BrowserWindows and
  IPC handlers behind webpack aliases, dynamic IPC channel names, and endpoints.
- **Size is manageable:** about 50 MB raw / 8 MB gzipped for a 383 MB app. The semantic graph is 75% of
  it and isn't needed for the map, so the stored result can drop it (~11 MB raw application graph).
- **Compute is the cost:** about 1.5 GB RAM and 80 s for a mid-size app, and 30+ min for VS Code-scale
  apps. Workers need a per-job timeout and a file-count cap.

## Beyond Electron (T021)

Generated by `fixtures/tools/target-fixtures.mjs` (set `REA_SCRIPT` to `rea-agents/scripts/rea.mjs`) from
hand-written samples with answer keys in `fixtures/sample-apps/*/ANSWER-KEY.md`. Each file is one JSON
object keyed by REA operation name, holding that command's unmodified envelope (local paths scrubbed
to `<INPUT_PATH>` / `<INPUT_DIR>`). See `docs/targets.md` for what each target needs.

| File | Sample | REA commands |
|---|---|---|
| `tiny-dotnet.rea-6.4.0.json` | `sample-apps/tiny-dotnet/TinyNotes.exe` (C#, 7 KB) | `inspect_managed_artifact`, `inspect_managed_members`, `inspect_managed_native_boundaries`, `project_managed_application_graph` |
| `tiny-android.rea-6.4.0.json` | `sample-apps/tiny-android/tiny-notes.apk` (Java, 13 KB) | `inspect_artifact`, `project_android_application_graph` (inventory only: no jadx provider) |
| `reaforweb-dev-landing.web-bundle.rea-6.4.0.json` | this site's own landing page, dev build on localhost | `analyze_web_bundle` (single envelope, not keyed) |
