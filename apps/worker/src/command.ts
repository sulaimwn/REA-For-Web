import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WorkerError } from "./limits.js";

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
};
export type CommandResult = { code: number | null; stdout: string; stderr: string };
export type DockerExecutor = (args: string[], options: CommandOptions) => Promise<CommandResult>;

export async function executeCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  options.signal.throwIfAborted();
  const child = spawn(command, args, {
    shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    signal: options.signal, killSignal: "SIGKILL",
  });
  let stdout = "";
  let stderr = "";
  let failure: unknown;
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", error => { failure ??= error; });
    child.once("close", code => resolve(code));
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
