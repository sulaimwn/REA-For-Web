# rea-studio (local mode CLI)

Analyze an Electron app or a .NET program **on your own machine** and write a
REA for Web project file you can open in the browser. Nothing is uploaded.

```sh
# from the repository root
npm run analyze -w rea-studio -- path/to/app          # extracted Electron app directory
npm run analyze -w rea-studio -- path/to/app.asar     # or an .asar archive
npm run analyze -w rea-studio -- path/to/Program.exe  # or a .NET program (.exe or .dll)
```

This runs [REA](https://github.com/morluto/rea) (`rea-agents@6.4.0`, pinned),
converts its output with `@rea-studio/rea-adapter`, and writes `<app>.studio.json`
in the directory you ran npm from. Electron/JS apps use
`analyze-javascript-application`. .NET programs use the three `inspect-managed-*`
commands and `project-managed-application-graph`: REA reads the .NET metadata and
IL without loading the assembly. Native (non-.NET) executables are refused with an
explanation; they need Ghidra (see `docs/targets.md`). Then open the site's **/open** page (locally: `npm run dev`, then
http://localhost:3000/open) and drop the file in. Your browser reads it; it
isn't sent anywhere.

| Option | |
|---|---|
| `--out <file>` | Output path (default `<app name>.studio.json`) |
| `--max-heap-mb <n>` | Heap for REA's analyzer workers (REA's default is 1024). Raising it costs time and memory and, on GitHub Desktop, recovered nothing. |

**Safety:** REA parses the app's files as text and never runs the app. It runs
with your user's permissions, on your machine.

Existing output files are never overwritten; choose a new `--out` name for a
second analysis. Raw analyzer output is limited to 1 GiB while it is written.

**What to expect** (measured on Windows 11, Node 24): the tiny sample takes a few
seconds; GitHub Desktop 3.6.5 (383 MB) takes 1.5 to 2.5 minutes and ~1.5 GB of RAM,
producing a 4.5 MB project. The first run after installing can be slower.
See `fixtures/README.md` for what REA can and can't recover.

The project file contains paths relative to the app, not your machine's paths,
so it's safe to share if the app is.
