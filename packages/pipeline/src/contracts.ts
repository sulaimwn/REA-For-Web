// Browser-safe API contracts. Analysis facts remain StudioProject.
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
export const UPLOAD_TTL_SECONDS = 24 * 60 * 60;
export const SIGNED_UPLOAD_SECONDS = 10 * 60;
export type UploadRequest = { name: string; bytes: number; sha256: string };
export type UploadTicket = {
  jobId: string;
  jobToken: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
};
export type JobStatus = {
  jobId: string;
  /** The authorized job's own filename; never taken from the shared result cache. */
  uploadName?: string;
  status: 'awaiting-upload' | 'queued' | 'running' | 'succeeded' | 'failed';
  progress?: { phase: string; message: string };
  projectId?: string;
  cacheHit?: boolean;
  error?: string;
  errorCode?: 'timeout';
};
export class PipelineError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}
export function validateUpload(value: unknown): UploadRequest {
  const v = value as Partial<UploadRequest> | null;
  if (
    !v ||
    typeof v.name !== 'string' ||
    v.name.length > 200 ||
    !/\.asar$/iu.test(v.name) ||
    /[\x00-\x1f/\\]/u.test(v.name) ||
    !Number.isSafeInteger(v.bytes) ||
    (v.bytes ?? 0) < 1 ||
    (v.bytes ?? Infinity) > MAX_UPLOAD_BYTES ||
    typeof v.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(v.sha256)
  ) {
    throw new PipelineError(400, 'Choose an .asar file up to 512 MB.');
  }
  return v as UploadRequest;
}
export function validateJobId(id: string): string {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(id))
    throw new PipelineError(404, 'Job not found.');
  return id;
}
