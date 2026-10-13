# R002 — Independent native/Android review (codex)

**Branch:** `codex/T021-native-android-review`
**Status:** review passed for Claude's T021 snapshot `ca35f7f`, with the fixes below.

## What changed
- Accept the native/Android additive schema proposal in `docs/targets.md` at schema 0.1.0.
- Enforce the MCP byte limit on complete lines before allocating them, validate JSON-RPC/UTF-8, validate configured limits, and handle abort/close without dangling requests or late exit waits.
- Preserve every native/Android query's REA limitations on evidence and in the project.
- Native URL/storage classification and possible string use are Studio heuristics. Keep observed literal evidence alongside the inference; direct Ghidra callees remain REA facts. Missing collection results are partial coverage.
- Android constructors with unavailable bodies remain visible. The sample now has 32 nodes/40 links and partial coverage because five retained method bodies are unavailable. Missing bodies aren't claimed to be empty or native/abstract. Caps and incomplete inventories also make coverage partial.
- Keep an activity alias's exported flag separate from its target's access flag. Explain alias grouping and permission-dependent access.
- Explain entry-style native symbols and Android launcher-onCreate flags as Studio heuristics in Inspector/Ask; remove speculative synthetic-name rewriting from REA reference resolution.

## How verified
- All eight workspaces typecheck; production Next build passes with seven demos.
- 196 tests pass across runnable workspace suites: web 13, worker 33, CLI 16, adapter 100, pipeline 11, Ask 16, MCP 7. The initial all-workspace invocation reported the schema's missing test script and one bad new test lookup; schema typecheck passed and the corrected Ask suite passed separately. Use `npm test --workspaces --if-present` for the full invocation.
- CLI suite includes actual JADX analysis of the committed APK and a fresh local Chrome page capture, with no skipped tests.
- Actual native CLI run against the committed sample using the installed Ghidra 12.1.4/JDK 21: 45.4 s, 96 nodes/136 links, 49 functions/43 imports, one URL/two storage strings. Target never executed.
- Browser at port 3112: Android manifest facts and five unknown constructors visible; native URL Inspector shows observed `list_strings` evidence and separate inferred classification/use. No console warnings/errors in the inspected native view.
- Proof images outside Git: `../R002-android-review.png`, `../R002-native-review.png`.

## Not done / known issues
- T024's newly committed `e0b9484` worker continuation is the next independent review, before upload integration. Its owner checkout is left untouched.
- Provider requests in local CLI mode can still run until the provider exits; the Docker worker has an independent job deadline.
- Android constant field values and annotated bridge member inventory aren't exposed by the current REA tools. Library namespaces are intentionally omitted from deep decompilation.
- Native calls cover resolved direct calls, not all indirect/runtime behavior; collection completeness is scoped to the queried inventories.

## Interface agreement
Codex agrees to Claude's fixture-backed native/Android node kinds, target kinds, APK format and `references` relation. No new field shapes were introduced by this review. Uploads will keep using `StudioProject` only.
