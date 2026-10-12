import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { ByteLimit } from "./command.js";
import { preflightTarget, type TargetKind } from "./preflight.js";
import { REA_VERSION, WorkerError, resolveLimits } from "./limits.js";

let deadline: ReturnType<typeof setTimeout> | undefined;

async function main() {
  // This entry point is image-internal. There is deliberately no host REA fallback.
  if (process.platform !== "linux" || process.getuid?.() === 0) {
    throw new WorkerError("invalid_input", "Container entry point requires non-root Linux.");
  }
  const [kind, files, inputBytes, outputBytes, heap, timeout] = process.argv.slice(2);
  if (kind !== "asar" && kind !== "directory") throw new WorkerError("invalid_input", "Invalid target kind.");
  const limits = resolveLimits({
    maxFiles: Number(files), maxInputBytes: Number(inputBytes), maxOutputBytes: Number(outputBytes),
    heapMb: Number(heap), timeoutMs: Number(timeout),
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
  await preflightTarget("/input/target", kind as TargetKind, limits);
  const child = spawn(process.execPath, [
    "/opt/rea/node_modules/rea-agents/scripts/rea.mjs", "analyze-javascript-application", "/input/target",
    "--artifact-format", kind, "--format", "json", "--max-heap-mb", String(limits.heapMb),
    "--analysis-timeout-ms", String(limits.timeoutMs),
  ], {
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
    await pipeline(child.stdout, new ByteLimit(limits.maxOutputBytes), process.stdout);
    const code = await closed;
    if (spawnError !== undefined) throw spawnError;
    if (code !== 0) throw new WorkerError("analysis_failed", `REA exited with code ${code}.`);
  } catch (error) {
    child.kill("SIGKILL");
    await closed.catch(() => undefined);
    throw error;
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
