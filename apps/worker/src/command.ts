import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WorkerError } from "./limits.js";
import { OWNER_HEARTBEAT, OWNER_HEARTBEAT_INTERVAL_MS } from "./owner-heartbeat.js";

export class ByteLimit extends Transform {
  bytes = 0;
  constructor(private maxBytes: number) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      callback(new WorkerError("output_limit_exceeded", "Analysis output exceeded its byte limit."));
    } else callback(null, chunk);
  }
}

export type CommandOptions = {
  signal: AbortSignal;
  onStderr?: (chunk: Buffer) => void;
  output?: { path: string; maxBytes: number };
  /** Docker attach only: keep the sandbox's private owner-liveness channel alive. */
  ownerHeartbeat?: true;
};
export type CommandResult = { code: number | null; stdout: string; stderr: string };
export type DockerExecutor = (args: string[], options: CommandOptions) => Promise<CommandResult>;

export async function executeCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  options.signal.throwIfAborted();
  const spawnOptions = {
    shell: false, windowsHide: true,
    signal: options.signal, killSignal: "SIGKILL",
  } as const;
  const child = options.ownerHeartbeat
    ? spawn(command, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(command, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let failure: unknown;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (options.ownerHeartbeat && child.stdin) {
    const input = child.stdin;
    input.on("error", () => clearInterval(heartbeat));
    const beat = () => {
      if (input.destroyed) { clearInterval(heartbeat); return; }
      input.write(OWNER_HEARTBEAT);
    };
    beat();
    heartbeat = setInterval(beat, OWNER_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
  }
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", error => { failure ??= error; });
    child.once("close", code => { clearInterval(heartbeat); resolve(code); });
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-16_384);
    try { options.onStderr?.(chunk); }
    catch (error) { failure ??= error; child.kill("SIGKILL"); }
  });
  let pumped: Promise<void> = Promise.resolve();
  if (options.output) {
    const sink = createWriteStream(options.output.path, { flags: "wx", mode: 0o600 });
    pumped = pipeline(child.stdout, new ByteLimit(options.output.maxBytes), sink).catch(error => {
      failure ??= error;
      child.kill("SIGKILL");
    });
  } else {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 128 * 1024) {
        failure ??= new WorkerError("docker_failed", "Docker control response was oversized.");
        child.kill("SIGKILL");
      }
    });
  }
  const code = await closed;
  await pumped;
  if (failure !== undefined) throw failure;
  return { code, stdout, stderr };
}

export const executeDocker: DockerExecutor = (args, options) => executeCommand("docker", args, options);
