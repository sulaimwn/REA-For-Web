export const REA_VERSION = "6.7.0";
export const WORKER_IMAGE = "rea-studio-worker:rea-6.7.0";
export { WORKER_USER, assertQueueIdentity } from "./queue-identity.js";
/** The worker image plus REA's Ghidra provider (Dockerfile.native). Needed for native programs only. */
export const NATIVE_WORKER_IMAGE = "rea-studio-worker-native:rea-6.7.0";

export type WorkerErrorCode =
  | "invalid_input" | "input_limit_exceeded" | "output_limit_exceeded"
  | "cancelled" | "timeout" | "docker_unavailable" | "unsafe_engine"
  | "docker_failed" | "analysis_failed" | "out_of_memory" | "cleanup_failed";

export class WorkerError extends Error {
  constructor(public readonly code: WorkerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerError";
  }
}

export type AnalysisLimits = {
  timeoutMs: number;
  sourceTimeoutMs: number;
  maxFiles: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  memoryMb: number;
  heapMb: number;
  cpus: number;
};

export const DEFAULT_LIMITS: Readonly<AnalysisLimits> = Object.freeze({
  timeoutMs: 900_000,
  sourceTimeoutMs: 180_000,
  // Admission only (preflight); REA is bounded by memory, CPU and the deadline. Big Electron apps ship
  // thousands of files, so 20,000 (the allowed maximum) lets real apps through.
  maxFiles: 20_000,
  maxInputBytes: 512 * 1024 * 1024,
  maxOutputBytes: 128 * 1024 * 1024,
  memoryMb: 2_048,
  heapMb: 1_024,
  cpus: 1,
});

export function resolveLimits(overrides: Partial<AnalysisLimits> = {}): AnalysisLimits {
  const limits = {
    ...DEFAULT_LIMITS, ...overrides,
    sourceTimeoutMs: overrides.sourceTimeoutMs ?? Math.min(DEFAULT_LIMITS.sourceTimeoutMs, overrides.timeoutMs ?? DEFAULT_LIMITS.timeoutMs),
  };
  const ranges: Record<keyof AnalysisLimits, readonly [number, number]> = {
    timeoutMs: [1_000, 1_800_000], sourceTimeoutMs: [1, 1_800_000], maxFiles: [1, 20_000],
    maxInputBytes: [1, 1024 * 1024 * 1024], maxOutputBytes: [1, 256 * 1024 * 1024],
    memoryMb: [512, 8_192], heapMb: [64, 4_096], cpus: [0.1, 4],
  };
  for (const key of Object.keys(ranges) as (keyof AnalysisLimits)[]) {
    const [min, max] = ranges[key];
    const value = limits[key];
    if (!Number.isFinite(value) || value < min || value > max ||
        (key !== "cpus" && !Number.isSafeInteger(value))) {
      throw new WorkerError("invalid_input", `Invalid worker limit: ${key}.`);
    }
  }
  if (limits.heapMb > limits.memoryMb - 256) {
    throw new WorkerError("invalid_input", "Heap must leave at least 256 MiB for other processes.");
  }
  if (limits.sourceTimeoutMs > limits.timeoutMs) {
    throw new WorkerError("invalid_input", "Source timeout must fit within the whole-job deadline.");
  }
  return limits;
}

/** Operator setting: run .exe/.dll jobs in the native image (built and present on this host). */
export function nativeWorkerFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.REA_NATIVE_WORKER === undefined || env.REA_NATIVE_WORKER === "0") return false;
  if (env.REA_NATIVE_WORKER === "1") return true;
  throw new WorkerError("invalid_input", "REA_NATIVE_WORKER must be 0 or 1.");
}

// Operator setting only; upload requests cannot change sandbox limits.
export function queueLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): AnalysisLimits {
  return resolveLimits({
    ...(env.REA_ANALYSIS_TIMEOUT_MS === undefined ? {} : { timeoutMs: Number(env.REA_ANALYSIS_TIMEOUT_MS) }),
    ...(env.REA_SOURCE_TIMEOUT_MS === undefined ? {} : { sourceTimeoutMs: Number(env.REA_SOURCE_TIMEOUT_MS) }),
    // Ghidra runs on the JVM, which one CPU starves: jq 1.8.2 took 124–145 s on 1 CPU, 52–57 s on 2, 42 s on 4.
    ...(env.REA_ANALYSIS_CPUS === undefined ? {} : { cpus: Number(env.REA_ANALYSIS_CPUS) }),
    // Big real apps (T057): one job runs at a time, so a dedicated host can give it most of its memory.
    // resolveLimits keeps every value inside the sandbox's reviewed ranges.
    ...(env.REA_ANALYSIS_MEMORY_MB === undefined ? {} : { memoryMb: Number(env.REA_ANALYSIS_MEMORY_MB) }),
    ...(env.REA_ANALYSIS_HEAP_MB === undefined ? {} : { heapMb: Number(env.REA_ANALYSIS_HEAP_MB) }),
    ...(env.REA_ANALYSIS_MAX_FILES === undefined ? {} : { maxFiles: Number(env.REA_ANALYSIS_MAX_FILES) }),
    ...(env.REA_ANALYSIS_MAX_INPUT_BYTES === undefined ? {} : { maxInputBytes: Number(env.REA_ANALYSIS_MAX_INPUT_BYTES) }),
  });
}
