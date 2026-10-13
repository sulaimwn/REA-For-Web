import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  adaptManagedFiles, adaptReaFile, isManagedArtifactFile, managedProjectionInput, type ManagedReaFiles,
} from "@rea-studio/rea-adapter/file";
import { collectNativeBundle, ghidraConfigured } from "@rea-studio/rea-adapter/native-session";
import { ByteLimit } from "./command.js";
import { PROGRAM_KINDS, TARGET_KINDS, preflightTarget, type TargetKind } from "./preflight.js";
import { REA_VERSION, WorkerError, resolveLimits, type AnalysisLimits } from "./limits.js";

const REA_SCRIPT = "/opt/rea/node_modules/rea-agents/scripts/rea.mjs";
let deadline: ReturnType<typeof setTimeout> | undefined;

const progress = (phase: string, message: string) =>
  process.stderr.write(`${JSON.stringify({ rea_progress: { phase, message } })}\n`);

/** Runs one REA command with its JSON written to `outPath` (bounded); returns REA's exit code. */
async function runRea(args: string[], outPath: string, limits: AnalysisLimits): Promise<number | null> {
  const child = spawn(process.execPath, [`--max-old-space-size=${limits.heapMb}`, REA_SCRIPT, ...args, "--format", "json"], {
    shell: false, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  });
  let spawnError: unknown;
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", error => { spawnError = error; });
    child.once("close", resolve);
  });
  child.stderr.pipe(process.stderr, { end: false });
  try {
    await pipeline(child.stdout, new ByteLimit(limits.maxOutputBytes), createWriteStream(outPath, { flags: "wx", mode: 0o600 }));
    const code = await closed;
    if (spawnError !== undefined) throw spawnError;
    return code;
  } catch (error) {
    child.kill("SIGKILL");
    await closed.catch(() => undefined);
    throw error;
  }
}

async function analyzeJavaScript(targetPath: string, kind: TargetKind, temp: string, limits: AnalysisLimits, targetName: string) {
  const rawPath = join(temp, "raw.json");
  const code = await runRea([
    "analyze-javascript-application", targetPath, "--artifact-format", kind,
    "--max-heap-mb", String(limits.heapMb), "--analysis-timeout-ms", String(limits.sourceTimeoutMs),
  ], rawPath, limits);
  if (code !== 0 && code !== 1) throw new WorkerError("analysis_failed", `REA exited with code ${code}.`);
  // Both phases share Docker's CPU/RAM limits and the whole-container deadline.
  // Only the adapter reads raw JSON; stdout now contains StudioProject only.
  const result = await adaptReaFile(rawPath, {
    reaVersion: REA_VERSION, maxBytes: limits.maxOutputBytes,
    targetName,
    // A nonzero exit must carry valid, explicitly partial timeout Evidence.
    // Other errors and cleanup failures can never publish an artifact.
    retainedTimeoutEvidence: code === 0 ? 'allow' : 'require',
  });
  await rm(rawPath);
  return result;
}

/** A Windows program: .NET metadata when REA finds a managed assembly, otherwise Ghidra (native image only). */
async function analyzeProgram(targetPath: string, temp: string, limits: AnalysisLimits, targetName: string) {
  const options = { reaVersion: REA_VERSION, maxBytes: limits.maxOutputBytes, targetName };
  const rea = async (args: string[], outPath: string) => {
    const code = await runRea(args, outPath, limits);
    if (code !== 0) throw new WorkerError("analysis_failed", `REA ${args[0]} exited with code ${code}.`);
  };
  const files: ManagedReaFiles & { projection: string } = {
    artifact: join(temp, "managed-artifact.json"),
    members: join(temp, "managed-members.json"),
    boundaries: join(temp, "managed-native-boundaries.json"),
    projection: join(temp, "managed-graph.json"),
  };
  progress("inspect", "Reading the program's headers");
  await rea(["inspect-managed-artifact", targetPath], files.artifact);
  if (await isManagedArtifactFile(files.artifact, limits.maxOutputBytes)) {
    progress("managed", "Reading .NET metadata: types, methods, calls and native imports");
    await rea(["inspect-managed-members", targetPath], files.members);
    await rea(["inspect-managed-native-boundaries", targetPath], files.boundaries);
    const input = join(temp, "managed-graph-input.json");
    await writeFile(input, await managedProjectionInput(files, limits.maxOutputBytes), { flag: "wx", mode: 0o600 });
    await rea(["project-managed-application-graph", input], files.projection);
    return adaptManagedFiles(files, options);
  }
  if (!ghidraConfigured()) {
    throw new WorkerError("invalid_input", "This is a native program, not .NET. Native programs need the native analysis worker (Ghidra).");
  }
  progress("native", "Native program: Ghidra is importing and analyzing it");
  const bundle = await collectNativeBundle({
    reaScript: REA_SCRIPT, program: targetPath, maxMessageBytes: limits.maxOutputBytes,
    nodeArgs: [`--max-old-space-size=${limits.heapMb}`],
    // Ghidra's JVM gets the same heap budget as REA's Node analysis.
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "", GHIDRA_HEADLESS_MAXMEM: `${limits.heapMb}m` },
    onProgress: message => progress("native", message),
  });
  const bundlePath = join(temp, "native-bundle.json");
  await writeFile(bundlePath, JSON.stringify(bundle), { flag: "wx", mode: 0o600 });
  if ((await stat(bundlePath)).size > limits.maxOutputBytes) {
    throw new WorkerError("output_limit_exceeded", "Analysis output exceeded its byte limit.");
  }
  return adaptReaFile(bundlePath, options);
}

async function main() {
  // This entry point is image-internal. There is deliberately no host REA fallback.
  if (process.platform !== "linux" || process.getuid?.() === 0) {
    throw new WorkerError("invalid_input", "Container entry point requires non-root Linux.");
  }
  const [kind, files, inputBytes, outputBytes, heap, timeout, sourceTimeout, targetName] = process.argv.slice(2);
  if (!TARGET_KINDS.includes(kind as TargetKind)) throw new WorkerError("invalid_input", "Invalid target kind.");
  if (!targetName || targetName.length > 200 || /[\x00-\x1f/\\]/u.test(targetName)) {
    throw new WorkerError("invalid_input", "Target name must be a filename up to 200 characters.");
  }
  const limits = resolveLimits({
    maxFiles: Number(files), maxInputBytes: Number(inputBytes), maxOutputBytes: Number(outputBytes),
    heapMb: Number(heap), timeoutMs: Number(timeout), sourceTimeoutMs: Number(sourceTimeout),
    // Runtime memory is enforced by Docker; permit operator-selected heap sizes.
    memoryMb: 8_192,
  });
  // This deadline survives a host-worker crash/disconnection. Exiting the main
  // process ends the container and its PID namespace, including REA descendants.
  deadline = setTimeout(() => {
    process.stderr.write('{"studio_worker_error":{"code":"timeout","message":"Container deadline exceeded."}}\n');
    process.exit(124);
  }, limits.timeoutMs);
  deadline.unref();
  const installed: unknown = JSON.parse(await readFile("/opt/rea/node_modules/rea-agents/package.json", "utf8"));
  if ((installed as { version?: unknown }).version !== REA_VERSION) {
    throw new WorkerError("invalid_input", "Unexpected REA version in worker image.");
  }
  const targetKind = kind as TargetKind;
  const targetPath = targetKind === "directory" ? "/input/target" : `/input/target.${targetKind}`;
  await preflightTarget(targetPath, targetKind, limits);
  const temp = await mkdtemp("/tmp/rea-analysis-");
  try {
    const result = PROGRAM_KINDS.includes(targetKind)
      ? await analyzeProgram(targetPath, temp, limits, targetName)
      : await analyzeJavaScript(targetPath, targetKind, temp, limits, targetName);
    await pipeline(Readable.from([JSON.stringify(result.project)]), new ByteLimit(limits.maxOutputBytes), process.stdout);
    process.stderr.write(`${JSON.stringify({ studio_worker_result: {
      projectId: result.project.id, reaVersion: REA_VERSION, report: result.report,
    } })}\n`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const code = error instanceof WorkerError ? error.code : "analysis_failed";
  const message = error instanceof Error ? error.message.slice(0, 1_024) : "Worker failed.";
  process.stderr.write(`${JSON.stringify({ studio_worker_error: { code, message } })}\n`);
  process.exitCode = 1;
}).finally(() => {
  if (deadline) clearTimeout(deadline);
});
