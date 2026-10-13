# Analysis worker foundation (T006)

This package runs **only static analysis** with `rea-agents@6.4.0`: Electron/JavaScript
apps (`.asar` or an extracted directory) and, since T024, Windows programs (`.exe`/`.dll`) and
Android apps (`.apk`).
It is an internal runner, not an upload API. It
returns a **StudioProject file** using T004's adapter. Raw REA output stays in
private container temporary storage and is removed after normalization. Only
`packages/rea-adapter` reads that raw JSON.

## Programs: .NET, native and Android (T024)

- **.NET** works in the standard image. REA reads the assembly's metadata and IL with
  `inspect-managed-artifact`, `inspect-managed-members` and `inspect-managed-native-boundaries`,
  then `project-managed-application-graph`.
- **Native programs** need REA's Ghidra provider, which lives in a second image,
  `rea-studio-worker-native:rea-6.4.0` (`Dockerfile.native`). It is the standard image plus:
  - a JDK 21 (Temurin, pinned by digest);
  - Ghidra 12.1.4 (SHA-256 checked);
  - jadx-headless-mcp 0.7.1 for Android (SHA-256 checked).

  It is about 2.2 GB. Inside it, the adapter's `native-session` drives `rea --mcp` so Ghidra
  imports the program once and answers every query.
- **Android apps** also run in the native image. REA's JADX provider (`REA_JADX_MCP_JAR`) reads the
  manifest, the app's classes and their decompiled methods in one `rea --mcp` session, with JADX's
  heap set by `REA_JADX_HEAP_MIB = heapMb`. The tiny sample takes 18 s in the sandbox.
- **Choosing the image:** set `native: true` (`--native` on the CLI, `REA_NATIVE_WORKER=1` for the
  queue) to run `.exe`/`.dll`/`.apk` jobs in the native image. Without it, a native program or an
  APK fails with `invalid_input` and says it needs the native worker. `.asar` and directories always use the
  standard image.
- **Same sandbox for both images:** no network, read-only root, non-executable `/tmp`, 128 PIDs,
  512 open files, 2 GiB. Measured with these limits:

  | Program | Time | Size | Peak PIDs | Peak memory |
  |---|---|---|---|---|
  | `tiny-notes.exe` | about 50 s | 96 nodes | 54 | ~700 MiB |
  | Windows `notepad.exe` (360 KB) | 245 s | 853 nodes, 1,863 links | 52 | ~940 MiB |

  Ghidra's JVM gets the analyzer heap (`heapMb`) via `GHIDRA_HEADLESS_MAXMEM`.
- **Preflight:** the program must be one ordinary file within `maxInputBytes`, starting with `MZ`
  (`\x7fELF` for a Linux `.elf`/`.so`, or `PK\x03\x04` for an APK).
  APK ZIP metadata also caps entry count and declared expanded bytes, rejects unsafe names,
  links, split/encrypted/ZIP64 archives, and bounds its directory to 8 MiB. No entries are
  extracted during admission. REA parses the program itself; it is never run.
- **Linux programs (T028):** `.elf`/`.so` jobs run in the native image only and go straight to Ghidra,
  with no .NET check. REA's Ghidra provider reads ELF only on Linux hosts, which the image is. The tiny
  sample takes about 31 s.
- **Known limit:** the collector makes one `procedure_callees` call per function (about 0.2 s each),
  so programs with many thousands of functions can hit the job deadline.

## Build and run

Install root dependencies and build the packages:

```sh
npm ci
npm run build
```

Use a local Linux Docker engine (Docker Desktop in Linux-container mode is
acceptable). Build the image from the repository root:

```sh
docker build -f apps/worker/Dockerfile -t rea-studio-worker:rea-6.4.0 .
# Optional, for native programs (downloads Ghidra and a JDK at build time):
docker build -f apps/worker/Dockerfile.native -t rea-studio-worker-native:rea-6.4.0 .
```

Image builds need network access. Analysis containers have no network, and jobs
use `--pull=never` so the image must already exist. The Node base image is pinned
by digest. `rea-runtime/package-lock.json` locks REA and its transitive packages;
the image uses `npm ci` with package scripts disabled and verifies REA's exact
version before analysis. Both images have been built locally; see the independent R003
handoff for the latest Docker verification results.

The runtime lock is independent of the workspace lock: REA is installed only
inside the analysis image. To intentionally update it, change the runtime
manifest and resolve its lock with `npm install --package-lock-only
--ignore-scripts --workspaces=false --prefix apps/worker/rea-runtime` from the
repo root. Review the lock and rerun the real Docker checks before changing the
worker's pinned version or image digest.

From the repository root, analyze the inert T001 directory sample:

```sh
npm run analyze --workspace=@rea-studio/worker -- fixtures/sample-apps/tiny-electron worker-results
```

For an ASAR, replace the first argument with its path. stdout is a final artifact
descriptor (`projectPath`, `projectId`, `adapterReport`, `reaVersion`, `elapsedMs`);
the file is normalized StudioProject JSON. stderr is bounded progress
metadata or a structured error. Ctrl+C/SIGTERM cancel the job and force container
removal. The CLI never invokes REA on the host.

Backend callers can use `runAnalysis({ targetPath, outputRoot, limits?, signal?,
onProgress? })`. Options and artifact types belong to this worker package only;
they are not a public HTTP API contract. `AnalysisArtifact.projectId` uses the
shared StudioProject id type; `adapterReport` records dropped/merged graph items.

## Limits and lifecycle

| Limit | Default |
| --- | --- |
| Whole-job deadline | 5 minutes (plus at most 10 seconds for container removal) |
| Packed/unpacked files | 5,000 |
| Physical input and logical ASAR contents | 512 MiB each |
| Raw REA output / normalized artifact | 128 MiB each |
| Container memory / swap total | 2 GiB / 2 GiB (no swap) |
| Analyzer / normalizer V8 heap | 1 GiB |
| CPU quota | 1 CPU |
| Processes | 128 |
| Writable temporary memory | 256 MiB |
| ASAR header / directory depth | 8 MiB / 64 levels |

Limits are validated; trusted backend callers can override them within bounded
ranges. Docker engine capabilities are checked first: Linux, memory/swap limits,
CPU quota, PID limits, and seccomp must be available. There is no insecure fallback.

Each job uses `create` → `start --attach` → inspect exit/OOM state → `rm --force`.
Container names are generated internally and labeled `rea-studio.worker=true`.
The container is non-root, has no capabilities, uses no-new-privileges, a
read-only root filesystem, a non-executable tmpfs, and one read-only input mount
with recursive submounts disabled. It has no writable host mounts or Docker
socket access. Docker's log driver is disabled to prevent duplicate unbounded
disk logs; normalized stdout is streamed with backpressure into a capped private
job file. REA analysis and adapter normalization share container CPU/RAM and the
whole-job deadline. Neither phase runs an uploaded target.

File-count/size/header checks happen inside the same resource-limited container
before REA starts. ASAR files are inspected without extracting or executing them.
Directory links, special files, archive links, traversal names, external unpacked
entries, and nested ASAR archives are rejected. To analyze an app with `.asar.unpacked`
sidecars, provide a finalized extracted application directory instead. Packaging
and extraction of uploads belongs to T007; never run target install/build scripts.

The host deadline includes Docker capability checks, creation, and analysis. A
second deadline inside the container stops analysis even if the host worker
disappears. A stalled/failed cleanup returns `cleanup_failed` with the container
name for operator action. Cancellation while Docker is creating a container can
leave daemon state uncertain; this is reported explicitly, never as confirmed
cleanup. A deployment needs an operator/reaper policy for labeled orphaned
containers when the Docker daemon is unreachable.

Output is published only after successful analysis/normalization, a validated
normalization receipt, and confirmed container removal. Failed/truncated/empty
output is discarded. REA exit-zero output can still contain partial coverage,
warnings, and unknowns: the adapter preserves these in StudioProject. The worker
does not interpret exit zero as complete coverage. No raw REA JSON is parsed by
worker code: its bounded file reader is the Node-only adapter subpath
`@rea-studio/rea-adapter/file`. The host parses only Docker state and orchestration
envelopes; it transports normalized bytes unchanged.

## Caller responsibilities

- Supply an app-owned, finalized input in a private staging directory; do not let
  an HTTP caller specify arbitrary host paths or modify the tree during analysis.
- Keep output outside the input tree. Results are private files under a generated
  job directory. Successful artifacts remain until the coordinator removes them.
- Bound queue concurrency, input retention, result retention, and total disk use.
  Per-job quotas do not constitute a global storage or compute budget.
- Use a local Docker engine that can see the host input path. Remote Docker hosts
  and runtime image building are not supported by this runner.
- Retain the normalized project's coverage/limitations. Avoid exposing internal
  artifact paths or diagnostic messages directly through T007's API.

## Verification

```sh
npm run typecheck
npm test --workspace=@rea-studio/worker
npm run test:docker --workspace=@rea-studio/worker
```

The normal suite uses T004 to convert real T001 fixture bytes, genuine archives
produced by the official Electron packager, and trusted fake Docker processes to
exercise lifecycle failures. It does not execute any uploaded application.

`test:docker` is opt-in and requires a suitable engine. Its 11 checks cover the container
configuration, directory/ASAR analysis, .NET, native Ghidra and Android JADX analysis,
limits, retained timeout evidence, cancellation and cleanup. Native/Android checks
skip only when the optional image is absent; `REA_REQUIRE_NATIVE_TESTS=1` makes that
a failure. No uploaded target is executed.

`.github/workflows/worker.yml` installs dependencies, typechecks all workspaces,
runs worker and adapter tests, builds both images, requires all Docker checks on a Linux GitHub
runner, and fails if worker containers remain. It runs on push/pull request and
can be dispatched manually after the workflow reaches GitHub. Actions are pinned
to commits, repository credentials are not persisted, and token permissions are
read-only. No image is pushed or deployed. Its first successful run is still
needed; neither mocks nor successful TypeScript checks prove production sandbox
behavior.

Container controls follow Docker's [create options](https://docs.docker.com/reference/cli/docker/container/create/),
[resource limits](https://docs.docker.com/engine/containers/resource_constraints/),
and [bind mount semantics](https://docs.docker.com/engine/storage/bind-mounts/).
ASAR preflight framing follows Electron's [disk implementation](https://github.com/electron/asar/blob/main/src/disk.ts).
