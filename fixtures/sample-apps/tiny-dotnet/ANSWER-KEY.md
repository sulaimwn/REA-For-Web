# TinyNotes (.NET) — answer key

A hand-written C# console app (`TinyNotes.cs`), compiled by `build.ps1` with the .NET Framework 4
`csc.exe`. Only ever read by REA; never run. `TinyNotes.exe` is committed because this compiler
isn't deterministic: rebuilding changes the MVID and requires regenerating the fixture
(`fixtures/tools/target-fixtures.mjs`).

What a correct analysis should find:

| Fact | Value | Verified in `tiny-dotnet.rea-6.4.0.json` |
|---|---|---|
| Assembly | `TinyNotes` 1.2.3.0, IL-only, AnyCPU, entry point `Program.Main` (`0x06000001`) | `inspect_managed_artifact` |
| References | `mscorlib` 4.0.0.0, `System.Net.Http` 4.0.0.0 | `inspect_managed_artifact.references` |
| Embedded resource | `TinyNotes.Strings.txt` (29 bytes) | `inspect_managed_artifact.resources` |
| Types | `Program`, `NoteStore`, `Sync`, `Native`, plus the compiler's `<PushAsync>d__0` state machine and `<Module>` | 6 types |
| Methods | 10, including `NoteStore.Save/Load`, `Sync.PushAsync`, `Program.Main` | `inspect_managed_members.methods` |
| Native calls (P/Invoke) | `user32.dll!MessageBoxW` (Unicode), `kernel32.dll!GetTickCount64`, `tinycrypto.dll!seal_note` (cdecl, managed name `SealNote`) | `inspect_managed_native_boundaries.pinvoke_imports` |
| File access | `NoteStore.Save` → `WriteAllText`, `NoteStore.Load` → `ReadAllText`, `.ctor` → `CreateDirectory` | `inspect_managed_members.call_edges` |
| Network | `<PushAsync>d__0.MoveNext` → `PostAsync` (`HttpClient`); the URL literal lives in `Main` | `call_edges` |
| Call graph | `Main` → `Save`, `Load`, `MessageBoxW`, `GetTickCount64`, `SealNote`, `PushAsync` | `call_edges` (36 total) |

REA's `project_managed_application_graph` keeps only structure: assembly, module, types, methods,
fields, P/Invoke imports and native implementations, with `contains`/`imports` edges. It does
**not** carry the call edges, references or resources, so an adapter should read those from the
inspections. External call targets are member names only: REA 6.4.0 doesn't resolve the TypeRef
that owns them (e.g. `WriteAllText` without `System.IO.File`).
