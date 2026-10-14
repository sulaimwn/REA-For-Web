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
| **Android (.apk)** | `inspect-artifact` → `project-android-application-graph`; deep: `inspect-android-package`, `search-android-classes`, `inspect-android-class`, `trace-android-references` | jadx-headless-mcp 0.7.1 JAR (`REA_JADX_MCP_JAR`) + a JDK; apktool for `decode-android-resources` | **yes, with the JAR** | `tiny-android.rea-6.4.0.json` |
| **Native (.exe/.dll/ELF/Mach-O)** | REA's MCP server (one Ghidra session): `open_binary`, `binary_overview`, `list_procedures`, `list_strings`, `procedure_callees`, `xrefs`, `resolve_containing_procedure` | Ghidra 12.1.x + JDK 21 (`GHIDRA_INSTALL_DIR`); or Hopper / IDA | **yes, with Ghidra** | `tiny-native.rea-6.4.0.json` |
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

### Android (JADX) — working
- Without the jadx provider, REA only proves what files the APK contains: manifest, DEX, resources, signing, native libraries and runtime family.
- **Approved and downloaded:** jadx-headless-mcp 0.7.1. Its SHA-256 matches the one pinned in REA's `JadxRelease.js`.
- **Collector** (`packages/rea-adapter/src/android-session.ts`): one `rea --mcp` session, about 18 s for the sample; each plain CLI command restarts JADX, about 9 s. It collects:
  - the package and its manifest;
  - every class name;
  - the app's own classes, meaning the package's namespace or a component's package, and their inner classes;
  - every method of those classes decompiled, capped at 1,500;
  - incoming references to each top-level class.
- **Adapter** (`packages/rea-adapter/src/android.ts`):
  - REA facts:
    - the package;
    - `android-permission` nodes;
    - `android-component` nodes (activity/service/receiver/provider, exported flag, intent actions, launcher);
    - classes and methods as `managed-type` / `managed-method`;
    - `references` edges.
  - Studio rules over the decompiled Java, labeled heuristic:
    - `addJavascriptInterface` → `bridge-api`, Android's version of an Electron preload bridge;
    - `WebView.loadUrl` → page/endpoint;
    - URL literals → endpoints;
    - database/preferences/file calls → storage;
    - `startService`/`startActivity`/`sendBroadcast` with `new Intent(…, X.class)` → `invokes`;
    - network APIs → `external-member`.
- **Result on the sample:** it matches the answer key except one URL. That URL lives in a `static final` field, which method-level decompilation doesn't show.
  - CLI: `rea-studio analyze app.apk` with `REA_JADX_MCP_JAR` set, about 23 s.
  - Demo: `/explore/tiny-android`.
- Not yet tested on a large real APK. Library classes (androidx, Kotlin, OkHttp…) are left out by design; they're listed in `search_android_classes` only.

### Native executables (Ghidra) — working
- **Linux ELF (T028):** the same collector and adapter work on Linux programs. `tiny-linux` matches its answer key.
  - **Host requirement:** REA's Ghidra provider reads ELF only on Linux/macOS hosts. On Windows it refuses with "Windows Ghidra P0 accepts PE targets only".
    - The fixture is collected inside the native worker image.
    - The CLI recognizes ELF by its header and explains the host requirement on Windows.
    - The worker accepts `.elf`/`.so` jobs in the native image.
    - The upload form admits explicit `.elf`/`.so` filenames, both using the `elf`
      parser/cache namespace. Rename extensionless programs to `.elf` first.
  - **Imports:** this collected ELF evidence does not attribute a providing library (Ghidra reports `<EXTERNAL>::name`), so imports are shown by symbol only.
  - **Entry point:** `_start` is marked as the entry.
  - Demo: `/explore/tiny-linux`.
- **macOS Mach-O (T035):** the same collector and adapter, with real evidence from jq 1.8.2's macOS release
  (`jq-1.8.2-macos.rea-6.4.0.json`, a thin x86_64 executable).
  - **Format:** REA reports `format: "mach-o"` (with `architecture` and `available_architectures`). The adapter maps it to the
    schema's `macho`.
  - **Host requirement:** the same as ELF. The fixture is collected inside the native worker image.
  - **Imports:** Mach-O imports name their library (`/usr/lib/libSystem.B.dylib::_name`). Ghidra lists each import's stub
    as a thunk function, so 1,667 listed functions become 1,537 function nodes plus 130 imports.
  - **Entry point:** Ghidra names it `entry`.
  - **Admission:** only thin Mach-O headers (32/64-bit, either byte order).
    - The CLI recognizes them by header.
    - The worker accepts `.macho` (rename extensionless programs) and `.dylib` in the native image.
    - Universal (`0xCAFEBABE`) binaries are refused with a "pick one architecture (`lipo -thin`)" message. REA's
      `available_architectures` suggests it could select one, but no universal sample has been tested.
  - Demo: `/explore/jq-macos` (T049), using the committed fixture.
  - **Not yet:** upload-form admission on main (T048 is in review), universal binaries and `.app`/`.ipa` bundles.
- Without a provider, `rea analyze <exe>` fails with `provider_unavailable` and lists `ghidra`, `hopper` and `ida` as candidates.
- **Approved and done locally:** Ghidra 12.1.4 (SHA-256 checked against the release page) with JDK 21.
  - Each REA CLI command starts its own Ghidra import (about 20 s), so the CLI talks to `rea --mcp` instead: one session, one import, then many queries (`packages/rea-adapter/src/native-session.ts`).
  - The collector asks for the overview, all procedures and strings, then each function's callees. For strings that look like a URL, a registry key or a data file, it asks for their references and the function that contains them.
- **Adapter** (`packages/rea-adapter/src/native.ts`):
  - functions become `native-function` nodes;
  - imports (`KERNEL32.DLL::CreateFileW`) become `native-import` nodes, reached through their thunks;
  - callees become `calls` edges;
  - strings become `endpoint`/`storage` nodes linked from the function that uses them.
- **Result on the sample:** `tiny-notes.exe` matches its answer key exactly (`fixtures/sample-apps/tiny-native/ANSWER-KEY.md`):
  - 49 functions and 43 imports;
  - `sync_notes` → WinINet + `https://api.example.com/notes`;
  - `remember_last` → the Reg* APIs + `Software\TinyNotes`.
  - The CLI takes about 70 s end to end. Demo: `/explore/tiny-native`.
- Not yet: decompiled code (`procedure_pseudo_code`), and limits for large binaries. Every function costs one `procedure_callees` call, so very large programs need a cap or REA's `get_call_graph`.
- Uploads: the reviewed native image ships JDK 21 + Ghidra 12.1.4 and JADX under
  the same sandbox. The local pipeline accepts `.asar`, `.exe`, `.dll`, `.apk`,
  `.elf` and `.so`. Hosted uploads still need an analysis host and private storage;
  local provider installation alone does not create that service.

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
3. **Android**: working locally with the approved jadx JAR; reuses the "bridge" UI for `addJavascriptInterface`.
4. **Native**: working locally with the approved Ghidra; worker image in T024 (review).
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

## Reviewed native and Android schema (R002)
Fixture-backed, additive, schema version unchanged:
- `appKind` gains `native` and `android`; `format` gains `apk` (native programs use `pe`).
- Native: `native-function` (address, name, entry-style symbol flag: a Studio heuristic). Imports reuse `native-import` with `managedName: null`.
- Android:
  - `android-component` (componentType, className, exported, intentActions, authorities, launcher);
  - `android-permission` (name).
  - Classes and methods reuse `managed-type` / `managed-method`. The WebView bridge reuses `bridge-api` (world `android-webview`).
- New relation `references` (REA `trace_android_references`: one class's code refers to another).
- `FindingCategory` gains `functions`, `components` and `permissions`, with per-kind lists `NATIVE_FINDING_CATEGORIES` and `ANDROID_FINDING_CATEGORIES`.

R002 accepts these additive shapes at schema 0.1.0. Native string classifications and possible
network/storage uses are labeled Studio heuristics; the original observed string evidence remains.
Android constructors with unavailable bodies stay visible and make coverage partial. Coverage is
scoped to the queried inventories; complete collection does not prove every possible behavior.
