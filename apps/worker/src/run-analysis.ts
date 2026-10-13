import { lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { executeDocker, type DockerExecutor } from "./command.js";
import { ProgressDecoder, type AnalysisProgress } from "./progress.js";
import { NATIVE_WORKER_IMAGE, REA_VERSION, WORKER_IMAGE, WorkerError, resolveLimits, type AnalysisLimits } from "./limits.js";
import { PROGRAM_KINDS, type TargetKind } from "./preflight.js";
import type { StudioProject } from "@rea-studio/schema";
import type { AdapterReport } from "@rea-studio/rea-adapter";

export type AnalysisOptions = {
  targetPath: string;
  /** Original archive filename, used only when REA has no package name. */
  targetName?: string;
  outputRoot: string;
  /**
   * Run .exe/.dll/.apk jobs in the native image (REA + Ghidra + JADX), which also maps native programs and APKs.
   * Without it, programs run in the standard image: .NET works; native programs and APKs are refused.
   */
  native?: boolean;
  limits?: Partial<AnalysisLimits>;
  signal?: AbortSignal;
  onProgress?: (progress: AnalysisProgress) => void;
};

// The file contains StudioProject only. Exit zero does not imply complete coverage.
export type AnalysisArtifact = {
  projectPath: string;
  projectId: StudioProject["id"];
  adapterReport: AdapterReport;
  reaVersion: string;
  elapsedMs: number;
};

function safeMountPath(path: string) {
  if (/[\x00-\x1f,"]/u.test(path)) {
    throw new WorkerError("invalid_input", "Input path contains unsupported Docker mount characters.");
  }
}

function within(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function plannedRoot(path: string): Promise<string> {
  let existing = path;
  const missing: string[] = [];
  for (;;) {
    try { return join(await realpath(existing), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(existing) === existing) throw error;
      missing.push(relative(dirname(existing), existing));
      existing = dirname(existing);
    }
  }
}

export function containerArgs(name: string, target: string, kind: TargetKind, limits: AnalysisLimits, targetName = basename(target), image = WORKER_IMAGE): string[] {
  safeMountPath(target);
  if (!targetName || targetName.length > 200 || /[\x00-\x1f/\\]/u.test(targetName)) {
    throw new WorkerError("invalid_input", "Target name must be a filename up to 200 characters.");
  }
  if (image !== WORKER_IMAGE && image !== NATIVE_WORKER_IMAGE) throw new WorkerError("invalid_input", "Unknown worker image.");
  // The native image runs under the same sandbox: Ghidra on notepad.exe peaked at 52 processes/threads and ~940 MiB.
  return [
    "create", "--pull=never", "--name", name, "--label", "rea-studio.worker=true",
    "--network=none", "--user=1000:1000", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges=true", "--init", "--pids-limit=128",
    `--memory=${limits.memoryMb}m`, `--memory-swap=${limits.memoryMb}m`, `--cpus=${limits.cpus}`,
    "--ulimit=nofile=512:512", "--log-driver=none", "--workdir=/tmp",
    `--env=NODE_OPTIONS=--max-old-space-size=${limits.heapMb}`,
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=268435456",
    "--mount", `type=bind,source=${target},target=/input/target${kind === "directory" ? "" : `.${kind}`},bind-recursive=disabled,readonly`,
    image, kind, String(limits.maxFiles), String(limits.maxInputBytes),
    String(limits.maxOutputBytes), String(limits.heapMb), String(limits.timeoutMs), String(limits.sourceTimeoutMs), targetName,
  ];
}

/** File targets by extension; anything else must be an extracted app directory. */
const FILE_KINDS: Record<string, TargetKind> = { ".asar": "asar", ".exe": "exe", ".dll": "dll", ".elf": "elf", ".so": "elf", ".apk": "apk" };

function jsonRecord(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Docker response.");
  return value as Record<string, unknown>;
}

export function assertEngine(info: Record<string, unknown>) {
  if (info.OSType !== "linux" || info.MemoryLimit !== true || info.SwapLimit !== true ||
      info.CpuCfsQuota !== true || info.PidsLimit !== true ||
      !Array.isArray(info.SecurityOptions) ||
      !info.SecurityOptions.some(value => typeof value === "string" && value.startsWith("name=seccomp"))) {
    throw new WorkerError("unsafe_engine", "A Linux Docker engine with memory, swap, CPU, PID, and seccomp support is required.");
  }
}

export const runAnalysis = (options: AnalysisOptions) => runWithDocker(options, executeDocker);

// Dependency injection is kept internal to this module's test/integration seam;
// production callers use runAnalysis, which always invokes the Docker CLI.
export async function runWithDocker(options: AnalysisOptions, docker: DockerExecutor): Promise<AnalysisArtifact> {
  const limits = resolveLimits(options.limits);
  if (options.signal?.aborted) throw new WorkerError("cancelled", "Analysis was cancelled.");
  const input = resolve(options.targetPath);
  const stats = await lstat(input);
  const fileKind = FILE_KINDS[extname(input).toLowerCase()];
  if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile()) || (stats.isFile() && !fileKind)) {
    throw new WorkerError("invalid_input", "Input must be an ordinary .asar, .exe, .dll, .elf, .so or .apk file, or an extracted app directory.");
  }
  const target = await realpath(input);
  safeMountPath(target);
  const kind: TargetKind = stats.isDirectory() ? "directory" : fileKind!;
  const image = options.native && PROGRAM_KINDS.includes(kind) ? NATIVE_WORKER_IMAGE : WORKER_IMAGE;
  const root = resolve(options.outputRoot);
  if (kind === "directory" && within(target, await plannedRoot(root))) {
    throw new WorkerError("invalid_input", "Output root must be outside the analyzed directory.");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const realRoot = await realpath(root);
  if (kind === "directory" && within(target, realRoot)) {
    throw new WorkerError("invalid_input", "Output root must be outside the analyzed directory.");
  }
  const jobDir = await mkdtemp(join(realRoot, "rea-job-"));
  const partialPath = join(jobDir, "studio-project.json.partial");
  const resultPath = join(jobDir, "studio-project.json");
  const name = `rea-studio-${randomUUID()}`;
  const startedAt = Date.now();
  const controller = new AbortController();
  let abortCode: "cancelled" | "timeout" | undefined;
  const cancel = () => { abortCode ??= "cancelled"; controller.abort(); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => {
    abortCode ??= "timeout";
    controller.abort();
  }, limits.timeoutMs);
  const progress = new ProgressDecoder(options.onProgress);
  let createAttempted = false;
  let created = false;
  let failure: unknown;
  try {
    const info = await docker(["info", "--format", "{{json .}}"], { signal: controller.signal });
    if (info.code !== 0) throw new WorkerError("docker_unavailable", "Docker engine is unavailable.");
    assertEngine(jsonRecord(info.stdout));
    const args = containerArgs(name, target, kind, limits, options.targetName, image);
    createAttempted = true;
    const creation = await docker(args, { signal: controller.signal });
    if (creation.code !== 0) throw new WorkerError("docker_failed", `Could not create worker container: ${creation.stderr}`);
    created = true;
    const attached = await docker(["start", "--attach", name], {
      signal: controller.signal,
      output: { path: partialPath, maxBytes: limits.maxOutputBytes },
      onStderr: chunk => progress.write(chunk),
    });
    progress.end();
    const inspection = await docker(["inspect", "--format", "{{json .State}}", name], { signal: controller.signal });
    if (inspection.code !== 0) throw new WorkerError("docker_failed", "Could not inspect completed worker.");
    const state = jsonRecord(inspection.stdout);
    if (state.OOMKilled === true) throw new WorkerError("out_of_memory", "Worker exceeded its memory limit.");
    if (state.ExitCode === 124) throw new WorkerError("timeout", "Container analysis timed out.");
    if (state.Running !== false || state.Status !== "exited" || state.ExitCode !== 0 || attached.code !== 0) {
      const code = progress.failure?.code;
      if (code === "invalid_input" || code === "input_limit_exceeded" || code === "output_limit_exceeded") {
        throw new WorkerError(code, progress.failure!.message);
      }
      throw new WorkerError("analysis_failed", `REA did not complete successfully: ${attached.stderr}`);
    }
    const output = await lstat(partialPath);
    if (!output.isFile() || output.isSymbolicLink() || output.size === 0 || output.size > limits.maxOutputBytes) {
      throw new WorkerError("analysis_failed", "REA produced no usable output artifact.");
    }
    if (progress.result?.reaVersion !== REA_VERSION) {
      throw new WorkerError("analysis_failed", "Worker produced no valid normalization receipt.");
    }
    controller.signal.throwIfAborted();
  } catch (error) {
    const systemCode = (error as NodeJS.ErrnoException | undefined)?.code;
    failure = abortCode ? new WorkerError(abortCode, abortCode === "timeout" ? "Analysis timed out." : "Analysis was cancelled.", { cause: error })
      : error instanceof WorkerError ? error
      : new WorkerError(systemCode === "ENOENT" ? "docker_unavailable" : "docker_failed", "Worker execution failed.", { cause: error });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    // Killing docker start alone leaves the container alive. Always remove by
    // its server-generated name, using an independent bounded cleanup signal.
    if (createAttempted) {
      try {
        const cleanup = await docker(["rm", "--force", name], { signal: AbortSignal.timeout(10_000) });
        if (cleanup.code !== 0 && (created || abortCode !== undefined || !/No such container/iu.test(cleanup.stderr))) {
          throw new Error(cleanup.stderr);
        }
      } catch (error) {
        failure = new WorkerError("cleanup_failed", `Could not confirm removal of container ${name}; operator cleanup is required.`, { cause: failure ?? error });
      }
    }
  }
  if (failure !== undefined) {
    if (dirname(jobDir) !== realRoot) throw new WorkerError("cleanup_failed", "Unexpected job cleanup path.");
    await rm(jobDir, { recursive: true, force: true });
    throw failure;
  }
  try { await rename(partialPath, resultPath); }
  catch (error) {
    if (dirname(jobDir) === realRoot) await rm(jobDir, { recursive: true, force: true });
    throw new WorkerError("analysis_failed", "Could not publish the analysis artifact.", { cause: error });
  }
  return {
    projectPath: resultPath, projectId: progress.result!.projectId,
    adapterReport: progress.result!.report, reaVersion: REA_VERSION, elapsedMs: Date.now() - startedAt,
  };
}
