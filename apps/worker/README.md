# Analysis worker foundation (T006)

This package runs **only static Electron/JavaScript analysis** with
`rea-agents@6.4.0`. It is an internal runner, not an upload API. It currently
returns an **opaque raw-result file**; T004 must validate and normalize that file
before it reaches any API or UI.

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
```

Image builds need network access. Analysis containers have no network, and jobs
use `--pull=never` so the image must already exist. The image installs REA with
package scripts disabled and verifies its exact version before analysis. REA's
transitive dependencies are resolved at image-build time; the image has not yet
been tested on this machine because Docker is unavailable.

From the repository root, analyze the inert T001 directory sample:

```sh
npm run analyze --workspace=@rea-studio/worker -- fixtures/sample-apps/tiny-electron worker-results
```

For an ASAR, replace the first argument with its path. stdout is a final artifact
descriptor (`rawResultPath`, `reaVersion`, `elapsedMs`); stderr is bounded progress
metadata or a structured error. Ctrl+C/SIGTERM cancel the job and force container
removal. The CLI never invokes REA on the host.

Backend callers can use `runAnalysis({ targetPath, outputRoot, limits?, signal?,
onProgress? })`. Options and artifact types belong to this worker package only;
they are not a shared StudioProject schema or public API contract.

## Limits and lifecycle

| Limit | Default |
| --- | --- |
| Whole-job deadline | 5 minutes (plus at most 10 seconds for container removal) |
| Packed/unpacked files | 5,000 |
| Physical input and logical ASAR contents | 512 MiB each |
| stdout artifact | 128 MiB |
| Container memory / swap total | 2 GiB / 2 GiB (no swap) |
| REA heap | 1 GiB |
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
disk logs; stdout is streamed with backpressure into a capped private job file.

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

Output is published only after successful container completion and confirmed
removal. Failed/truncated/empty output is discarded. REA exit-zero output can
still contain partial coverage, warnings, and unknowns: it is preserved byte for
byte for T004, not interpreted as complete analysis. No raw REA JSON is parsed by
the worker. It parses only Docker state and stderr orchestration envelopes.

## Caller responsibilities

- Supply an app-owned, finalized input in a private staging directory; do not let
  an HTTP caller specify arbitrary host paths or modify the tree during analysis.
- Keep output outside the input tree. Results are private files under a generated
  job directory. Successful artifacts remain until the coordinator removes them.
- Bound queue concurrency, input retention, result retention, and total disk use.
  Per-job quotas do not constitute a global storage or compute budget.
- Use a local Docker engine that can see the host input path. Remote Docker hosts
  and runtime image building are not supported by this runner.
- Connect T004 at the raw-result boundary and retain its coverage/limitations.
  Avoid exposing internal diagnostic paths/messages directly through T007's API.

## Verification

```sh
npm run typecheck
npm test --workspace=@rea-studio/worker
npm run test:docker --workspace=@rea-studio/worker
```

The normal suite uses real T001 fixture bytes, genuine archives produced by the
official Electron packager, and trusted fake Docker processes to exercise
lifecycle failures. It does not execute any uploaded application.

`test:docker` is opt-in and requires the built image and a suitable engine. It
analyzes the inert sample both as a directory and a generated ASAR; it fails when
Docker is missing. Real container/image verification is still pending. Neither
the mocks nor successful TypeScript checks prove production sandbox behavior.

Container controls follow Docker's [create options](https://docs.docker.com/reference/cli/docker/container/create/),
[resource limits](https://docs.docker.com/engine/containers/resource_constraints/),
and [bind mount semantics](https://docs.docker.com/engine/storage/bind-mounts/).
ASAR preflight framing follows Electron's [disk implementation](https://github.com/electron/asar/blob/main/src/disk.ts).
