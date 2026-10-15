# rea-studio (local mode CLI)

Analyze an application **on your own machine** and write a
REA for Web project file you can open in the browser. Nothing is uploaded.

```sh
# from the repository root
npm run analyze -w rea-studio -- path/to/app          # extracted Electron app directory
npm run analyze -w rea-studio -- path/to/app.asar     # or an .asar archive
npm run analyze -w rea-studio -- path/to/Program.exe  # or a .NET program (.exe or .dll)
npm run analyze -w rea-studio -- path/to/app.apk      # Android, with JADX configured
npm run analyze -w rea-studio -- https://example.com # capture a website in fresh Chrome
```

This runs [REA](https://github.com/morluto/rea) (`rea-agents@6.5.0`, pinned),
converts its output with `@rea-studio/rea-adapter`, and writes `<app>.studio.json`
in the directory you ran npm from. Electron/JS apps use
`analyze-javascript-application`. .NET programs use the three `inspect-managed-*`
commands and `project-managed-application-graph`: REA reads the .NET metadata and
IL without loading the assembly. Native Windows programs use Ghidra when
`GHIDRA_INSTALL_DIR` is set. Linux ELF and single-architecture macOS Mach-O
programs also use Ghidra and require a Linux or macOS host. Android APKs need
a full JDK 17+ (including the compiler, not a JRE) and the JADX headless MCP
0.7.1 JAR at `REA_JADX_MCP_JAR`; website URLs need
Chrome (optionally at `CHROME_PATH`). See the [target/provider notes](../../docs/targets.md).
Then open [the site's /open page](https://reaforweb.com/open) (locally: `npm run dev`, then
http://localhost:3000/open) and drop the file in. Your browser reads it; it
isn't sent anywhere.

| Option | |
|---|---|
| `--out <file>` | Output path (default `<app name>.studio.json`) |
| `--max-heap-mb <n>` | Heap budget in MiB for REA's JavaScript analyzer workers. |
| `--no-recover` | Skip re-analyzing JavaScript files whose relationships were dropped by the whole-app result budget. Faster, with less detail on large apps. |

**Safety:** program analysis parses files without executing the target. Website
capture loads the requested page, including its scripts, in a temporary Chrome
profile. Both run with your user's permissions, on your machine. No application
or project file is uploaded; using Ask separately sends analysis context to its
selected model provider.

Existing output files are never overwritten; choose a new `--out` name for a
second analysis. Raw analyzer output is limited to 1 GiB while it is written.

**What to expect:** the tiny Electron sample takes seconds; large applications
can take many minutes. Per-file JavaScript recovery is enabled by default and
adds work when the whole-app result dropped relationships. Use `--no-recover`
to trade that detail for speed. Native and Android timings depend on their
providers and collection budgets. See [fixture measurements](../../fixtures/README.md)
for historical runs and coverage limits; those timings are not a promise for
the current default CLI or a different machine.

The project file can contain code, strings and paths recovered from the target.
Review its contents before sharing an analysis of a private application.
