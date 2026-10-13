# Beyond Electron: what REA can analyze, and what each target needs (T021)

The human's goal: REA for Web should cover what REA covers, not only Electron. Everything below
was checked against **rea-agents 6.4.0 on this machine** (Windows, no extra providers installed),
using hand-written sample apps with answer keys in `fixtures/sample-apps/`.

## The key finding

REA's non-Electron application graphs use **the same graph schema** as Electron:
`project_managed_application_graph` returns `"schema": "JavaScriptApplicationGraph"`, with the
same node and edge shape (`node_id`, `kind`, `identity`, `observations[].evidence`; `relation`
edges). Only the node kinds differ (`managed-assembly`, `managed-type`, `managed-method`,
`managed-pinvoke-import`…). Our adapter's graph reading, evidence mapping and coverage
handling carry over; each target adds node-kind mappings plus target-specific facts.

## Target by target

| Target | REA commands | Provider needed | Works here today | Fixture |
|---|---|---|---|---|
| **Electron / JS app** | `analyze-javascript-application` | none | yes | `tiny-electron`, GitHub Desktop, VS Code |
| **.NET (.exe/.dll, managed)** | `inspect-managed-artifact`, `inspect-managed-members`, `inspect-managed-native-boundaries`, then `project-managed-application-graph` | none (REA's own managed provider) | **yes, complete** | `tiny-dotnet.rea-6.4.0.json` |
| **Android (.apk)** | `inspect-artifact` → `project-android-application-graph`; deep: `inspect-android-package`, `search-android-classes`, `inspect-android-method`, `trace-android-references` | jadx-headless-mcp 0.7.1 JAR (`REA_JADX_MCP_JAR`); apktool for `decode-android-resources` | inventory only | `tiny-android.rea-6.4.0.json` |
| **Native (.exe/.dll/ELF/Mach-O)** | `analyze`, `inspect`, `function`, `decompile`, `xrefs`, `search`, `trace` | Ghidra 12.1.x + Java (`GHIDRA_INSTALL_DIR`); or Hopper / IDA | no (`provider_unavailable`) | none yet |
| **Apple (.ipa / .app)** | `inspect-artifact` → `project-apple-application-graph`; plist / Mach-O / signature tools | inventory works anywhere; `inspect_macho`, `inspect_plist`, `inspect_signature` need a macOS host | inventory only | none yet |
| **Website by URL** | headless browser with a loopback CDP port → `list-browser-targets` → `analyze-web-bundle` | a Chromium the worker controls | **yes** (tested on our own local site) | `reaforweb-dev-landing.web-bundle.rea-6.4.0.json` |

### .NET (ready now)
- Real output for the sample matches its answer key exactly:
  - The assembly, its two references and the embedded resource.
  - 6 types and 10 methods.
  - The 3 P/Invoke imports with library, entry point and calling convention.
  - A **36-edge call graph**: `inspect-managed-members.call_edges`, which includes calls into file and network APIs.
- REA's projection keeps structure only. Call edges, references and resources must be read from the inspections, which the fixture keeps side by side.
- Limitation: external call targets have member names only (`WriteAllText`), not their declaring type.
- No code is loaded or executed: REA reads PE/CLI metadata and IL bytes.

### Android (needs one JAR)
- Without the jadx provider, REA only proves what files the APK contains: manifest, DEX, resources, signing, native libraries and runtime family.
- The interesting parts need jadx-headless-mcp 0.7.1, a Java program REA drives but doesn't download:
  - activities, services, receivers and providers
  - permissions
  - `addJavascriptInterface` bridges (Android's version of Electron preloads)
  - URLs
- The human approved downloading the provider. Android adapter and worker
  integration remain separate from the .NET/web phase reviewed here.

### Native executables (needs Ghidra)
- `rea analyze <exe>` fails with `provider_unavailable` and lists `ghidra`, `hopper` and `ida` as candidates.
- Ghidra (free, Apache-2.0) runs headless on Linux, so it fits the existing Docker worker: Java 21 plus a Ghidra 12.1.x release, roughly 1 GB more image.
- Native analysis is much slower than JS analysis, so it needs its own time and CPU limits.
- The human approved adding Ghidra. A separate worker image and acceptance tests
  are still needed; local provider setup alone does not enable hosted native uploads.

### Apple
- Inventory projection works on any host. Mach-O, plist and code-signature details need macOS tools that a Linux worker doesn't have.
- Treat it as inventory-only on hosted workers.

### Websites
- **Tested:** our own landing page in a dev build, served from localhost and loaded in headless Chrome with a scratch profile and a loopback-only debugging port.
  - `rea analyze-web-bundle <cdp> <target>` parsed all 24 scripts (`completeness: complete`).
  - It fingerprinted Next.js, React and webpack, and found 4 route strings and 57 endpoint candidates. Most of those are noise, such as `params.get('node')`, so T012's filtering matters here too.
  - Its output is its own format, not the application graph: `capture`, `observations {chunks, routes, endpoints, webmcp_declarations, source_maps}`, `inferences` (vendor and bundler fingerprints) and `unknowns`. A small adapter maps that onto page, script, framework, route and endpoint nodes.
  - `inspect-web-page` then `export-web-scripts` exported only a manifest: page inspection filters `script_sources` by policy. Use `analyze-web-bundle`, or a recorded `capture-browser-scenario`, for script retention.
- **Careful with browsers:** Edge implicitly signs in with the Windows account even in a fresh `--user-data-dir`. Automate Chromium or Chrome with a scratch profile, never a signed-in browser.
- This is a different sandbox model: the browser needs **network access to the target site**, while the analysis worker today runs with `--network=none`.
- Proposed design:
  1. A separate capture container runs headless Chromium behind an egress proxy that allows only the requested origin and blocks private, loopback and metadata IP ranges (SSRF).
  2. REA, in the same container, runs `analyze-web-bundle` against that browser's loopback CDP port.
  3. Only the JSON result leaves the container.
- The project uses `appKind: 'web'`, with its own small adapter for the bundle format (`packages/rea-adapter/src/web.ts`).
- **Done in local mode:** `rea-studio analyze https://…` opens the page in a headless Chrome and runs `analyze-web-bundle` against it.
  - Chrome gets a throwaway profile and a loopback-only debugging port, and the profile is deleted afterwards. Edge is never used.
  - The adapter maps scripts to files under the page, routes and endpoint candidates to their script, and framework/bundler fingerprints to inferred imports.
  - Demo: `/explore/reaforweb-site`, this site's own landing page (dev build).

## Proposed order
1. **.NET**: no new tools. Schema proposal plus a working prototype on `claude/T021-dotnet-prototype`.
2. **Websites**: no new analyzer, but needs the capture sandbox. Design above; Codex owns the worker.
3. **Android**: needs the jadx JAR (human approval). Reuses the "bridge" UI for `addJavascriptInterface`.
4. **Native**: Ghidra is human-approved; needs a separately reviewed worker image and limits.
5. **Apple**: inventory-only on Linux.

## Reviewed schema scope
See `notes/handoffs/2026-10-13-T021-claude.md`. In short:
- `target.appKind` gains `dotnet` and `web`; `format` gains `pe` and `url`.
  Android, native and Apple kinds still need their own fixture-backed proposals.
- New node kinds:
  - `assembly` (managed assembly + module)
  - `managed-type`
  - `managed-method`
  - `native-import` (a P/Invoke or native import, with library and entry point)
  - `external-member` (a called API outside the app)
- New relation: `calls` already exists and is reused.
- `FindingCategory` gains `types`, `methods`, `native-imports`, `external-apis`.
  References and resources are assembly facts rather than separate findings.
- Kinds that only make sense for one target never appear for others; existing Electron projects are unchanged.
