# TinyNotes (Linux ELF) — answer key

A hand-written C program (`tiny_notes.c`), compiled to an x86-64 Linux ELF by `build.sh`: gcc 12 in
the pinned Debian Node image, dynamically linked to glibc, symbols kept. Only ever read by REA through
its Ghidra provider; never run. `tiny-notes` is committed because rebuilding changes its bytes.

| Function | Calls (imports and functions) | Strings it uses |
|---|---|---|
| `main` | `save_note`, `remember_last`, `sync_notes`, `puts` | |
| `save_note` | `fopen`, `fwrite`, `strlen`, `fclose` | `notes.txt` |
| `remember_last` | `fopen`, `fprintf`, `fclose` | `settings.ini` |
| `sync_notes` | `getaddrinfo`, `socket`, `connect`, `snprintf`, `send`, `strlen`, `close`, `freeaddrinfo` | `https://api.example.com/notes` |

- **Imports carry no library.** ELF imports name only the symbol; the dynamic linker picks the library
  (`libc.so.6`) at run time. Ghidra reports them as `<EXTERNAL>::<name>`.
- **The rest of the 11 functions** are gcc's startup code (`_start`, `_init`, `_fini`,
  `register_tm_clones`…). `_start` is the ELF entry point.
- **Fixture:** `fixtures/samples/tiny-linux.rea-6.4.0.json` is REA 6.4.0 + Ghidra 12.1.4 output,
  collected inside the native worker image. REA's Ghidra provider accepts only PE programs on a
  Windows host ("Windows Ghidra P0 accepts PE targets only").
- **Regenerate:** `NATIVE_IMAGE=1 REA_SCRIPT=… node fixtures/tools/target-fixtures.mjs`.
