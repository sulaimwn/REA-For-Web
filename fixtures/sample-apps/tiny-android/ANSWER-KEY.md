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

What REA 6.4.0 finds **on this machine** (`tiny-android.rea-6.4.0.json`): inventory only.
`project_android_application_graph` lists `AndroidManifest.xml`, `resources.arsc`, `classes.dex`,
the signing files and runtime family `dalvik-art`. Components, permissions and the bridge need
REA's Android provider: `inspect-android-package` / `search-android-classes` report
`capability_unavailable` until `REA_JADX_MCP_JAR` points at a jadx-headless-mcp 0.7.1 JAR
(REA doesn't download it). `assets/index.html` isn't listed under `javascript` (only `.js` files are).
