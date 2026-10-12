export const REA_VERSION = "6.4.0";
export const WORKER_IMAGE = "rea-studio-worker:rea-6.4.0";

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
  maxFiles: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  memoryMb: number;
  heapMb: number;
  cpus: number;
};

export const DEFAULT_LIMITS: Readonly<AnalysisLimits> = Object.freeze({
  timeoutMs: 300_000,
  maxFiles: 5_000,
  maxInputBytes: 512 * 1024 * 1024,
  maxOutputBytes: 128 * 1024 * 1024,
  memoryMb: 2_048,
  heapMb: 1_024,
  cpus: 1,
});

export function resolveLimits(overrides: Partial<AnalysisLimits> = {}): AnalysisLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const ranges: Record<keyof AnalysisLimits, readonly [number, number]> = {
    timeoutMs: [1_000, 1_800_000], maxFiles: [1, 20_000],
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
  return limits;
}
