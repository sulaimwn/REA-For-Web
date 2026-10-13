# TinyNotes (Android) — answer key

A hand-written Android app (Java sources in `src/`, `AndroidManifest.xml`, `assets/index.html`),
built by `build.ps1` without Gradle: javac → d8 → aapt2 → zipalign → apksigner with a throwaway
key. Never installed or run; only read by REA.

What a complete analysis should find:

| Fact | Value |
|---|---|
| Package | `com.reaforweb.tinynotes` 1.2.3 (versionCode 3), minSdk 24, targetSdk 34 |
| Permissions | `INTERNET`, `RECEIVE_BOOT_COMPLETED` |
| Activity | `MainActivity` (exported launcher) — a WebView loading `file:///android_asset/index.html` |
| JavaScript bridge | `addJavascriptInterface(new NotesBridge(), "notesBridge")` exposing `save(title, body)` and `version()` — the Android equivalent of an Electron preload bridge |
| Service | `SyncService` (not exported) → POST to `https://api.example.com/notes` |
| Receiver | `BootReceiver` (exported, `BOOT_COMPLETED`) → starts `SyncService` |
| Provider | `NotesProvider` (`com.reaforweb.tinynotes.notes`, not exported) → SQLite `notes.db` |
| Web page | `assets/index.html` calls `window.notesBridge.save(...)` and `.version()` |

## What REA 6.4.0 finds

`tiny-android.rea-6.4.0.json` comes from REA's JADX provider (jadx-headless-mcp 0.7.1) in one MCP
session (`packages/rea-adapter/src/android-session.ts`).

Without the JAR, REA only inventories the APK's files: `inspect-android-package` reports
`capability_unavailable`. REA doesn't download the JAR.

**REA facts:**
- the package, versions, SDKs and both permissions;
- the decoded manifest: four components, their exported flags and intent filters, the launcher,
  and the provider's authority;
- the 5 app classes (including the inner `MainActivity.NotesBridge`) and their methods, each
  decompiled to Java;
- incoming class references, e.g. `BootReceiver → SyncService` and `NotesBridge → NotesProvider`.

**Studio rules over REA's decompiled Java** (labeled heuristic in the UI):
- the `notesBridge` bridge with `save` and `version`;
- `MainActivity` loading `assets/index.html`;
- `BootReceiver` and `MainActivity` starting `SyncService`;
- `NotesProvider` opening `notes.db`;
- `SyncService.push` opening a network connection (`new URL(ENDPOINT)`).

**Not found:** the URL `https://api.example.com/notes`. It's a `static final` field, and REA's
JADX tools decompile methods only: field values and class bodies aren't returned, and JADX shows
the constant's name (`ENDPOINT`) where javac inlined its value.
