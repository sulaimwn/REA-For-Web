import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { S3Client } from '@aws-sdk/client-s3';
import { reserveAdmission } from './admission.js';
export { networkIdentity, UPLOAD_BUSY_MESSAGE } from './admission.js';
import { LocalStore, R2Store, uploadKey, type ObjectStore } from './storage.js';
import {
  PipelineError,
  SIGNED_UPLOAD_SECONDS,
  UPLOAD_TTL_SECONDS,
  validateUpload,
  validateJobId,
  uploadKind,
  type UploadRequest,
  type UploadTicket,
  type JobStatus,
} from './contracts.js';
export { PipelineError, LocalStore };

export type UploadRecord = UploadRequest & {
  id: string;
  tokenHash: string;
  createdAt: number;
};
export type JobResult = {
  projectId: string;
  resultKey: string;
  uploadSha256: string;
  cacheHit: boolean;
};
const digest = (token: string) =>
  createHash('sha256').update(token).digest('hex');
// Web requests must fail when a live Redis connection stops replying. Worker
// connections keep their separate reconnect policy for long-running analysis.
const API_REDIS_COMMAND_TIMEOUT_MS = 5000;
export type PipelineConfig = {
  redisUrl: string;
  prefix: string;
  origin: string;
  store: ObjectStore;
  workRoot: string;
  visitorSecret?: string;
};
function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  if (!value)
    throw new PipelineError(503, `Upload service is not configured (${name}).`);
  return value;
}
export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PipelineConfig {
  const mode = required(env, 'PIPELINE_STORAGE');
  const origin = new URL(required(env, 'PIPELINE_PUBLIC_ORIGIN')).origin;
  const workRoot = required(env, 'PIPELINE_WORK_ROOT');
  let store: ObjectStore;
  if (mode === 'local') {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname))
      throw new Error(
        'Local storage is only for a loopback development origin.',
      );
    store = new LocalStore(
      required(env, 'PIPELINE_DATA_ROOT'),
      required(env, 'PIPELINE_UPLOAD_SECRET'),
    );
  } else if (mode === 'r2') {
    if (new URL(origin).protocol !== 'https:')
      throw new Error('R2 deployment requires HTTPS.');
    if (required(env, 'PIPELINE_ACCESS_KEY').length < 32)
      throw new Error(
        'Private beta access key must have at least 32 characters.',
      );
    const account = required(env, 'R2_ACCOUNT_ID');
    if (!/^[a-f0-9]{32}$/u.test(account))
      throw new Error('Invalid R2 account id.');
    store = new R2Store(
      new S3Client({
        region: 'auto',
        endpoint: `https://${account}.r2.cloudflarestorage.com`,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        requestHandler: {
          connectionTimeout: 5000,
          requestTimeout: 60000,
          // This SDK otherwise only warns when requestTimeout elapses.
          throwOnRequestTimeout: true,
        },
        credentials: {
          accessKeyId: required(env, 'R2_ACCESS_KEY_ID'),
          secretAccessKey: required(env, 'R2_SECRET_ACCESS_KEY'),
        },
      }),
      required(env, 'R2_BUCKET'),
    );
  } else throw new Error('PIPELINE_STORAGE must be local or r2.');
  const prefix = env.PIPELINE_QUEUE_PREFIX ?? 'rea-studio-v1';
  if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(prefix))
    throw new Error('Invalid queue prefix.');
  if (env.PIPELINE_VISITOR_LIMITS !== undefined && !['0', '1'].includes(env.PIPELINE_VISITOR_LIMITS))
    throw new Error('PIPELINE_VISITOR_LIMITS must be 0 or 1.');
  const visitorSecret = env.PIPELINE_VISITOR_LIMITS === '1'
    ? required(env, 'PIPELINE_VISITOR_SECRET') : undefined;
  if (visitorSecret && (visitorSecret.length < 32 || mode !== 'r2' || env.PIPELINE_TRUST_PROXY !== '1'))
    throw new Error('Visitor limits require R2, a trusted dedicated proxy and a 32-character private secret.');
  return {
    redisUrl: required(env, 'REDIS_URL'),
    prefix,
    origin,
    workRoot,
    store,
    ...(visitorSecret ? { visitorSecret } : {}),
  };
}

export class UploadControl {
  readonly redis: Redis;
  readonly queue: Queue<UploadRecord, JobResult>;
  private connectionReady: Promise<unknown> | undefined;
  constructor(public readonly config: PipelineConfig) {
    this.redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      commandTimeout: API_REDIS_COMMAND_TIMEOUT_MS,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    // Attach listeners so connection failures never become uncaught events.
    this.redis.on('error', () => {});
    this.queue = new Queue<UploadRecord, JobResult>('analysis', {
      connection: {
        url: config.redisUrl,
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
        commandTimeout: API_REDIS_COMMAND_TIMEOUT_MS,
        enableOfflineQueue: false,
      },
      prefix: config.prefix,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: UPLOAD_TTL_SECONDS },
        removeOnFail: { age: UPLOAD_TTL_SECONDS },
      },
    });
    this.queue.on('error', () => {});
  }
  private key(id: string) {
    return `${this.config.prefix}:upload:${validateJobId(id)}`;
  }
  async ready() {
    if (this.redis.status === 'wait')
      this.connectionReady ??= this.redis.connect();
    await this.connectionReady;
    await this.redis.ping();
  }
  async record(id: string): Promise<UploadRecord> {
    await this.ready();
    const raw = await this.redis.get(this.key(id));
    if (!raw) throw new PipelineError(404, 'Job not found or expired.');
    return JSON.parse(raw) as UploadRecord;
  }
  async authorize(id: string, token: string): Promise<UploadRecord> {
    const r = await this.record(id);
    if (
      !/^[a-f0-9]{64}$/u.test(token) ||
      !timingSafeEqual(Buffer.from(r.tokenHash), Buffer.from(digest(token)))
    )
      throw new PipelineError(404, 'Job not found or expired.');
    return r;
  }
  async create(value: unknown, identity?: string): Promise<UploadTicket> {
    const request = validateUpload(value);
    if (this.config.visitorSecret && !identity)
      throw new PipelineError(503, 'Upload visitor identity is unavailable.');
    await this.ready();
    const id = randomUUID(),
      token = randomBytes(32).toString('hex');
    await reserveAdmission(this.redis, this.queue, this.config.prefix, id, 'create', identity);
    const r: UploadRecord = {
      ...request,
      id,
      tokenHash: digest(token),
      createdAt: Date.now(),
    };
    await this.redis.set(
      this.key(id),
      JSON.stringify(r),
      'EX',
      UPLOAD_TTL_SECONDS,
    );
    const signed = await this.config.store.signUpload(
      id,
      request,
      this.config.origin,
    );
    return {
      jobId: id,
      jobToken: token,
      uploadUrl: signed.url,
      headers: signed.headers,
      expiresAt: new Date(
        Date.now() + SIGNED_UPLOAD_SECONDS * 1000,
      ).toISOString(),
    };
  }
  async complete(id: string, token: string) {
    const r = await this.authorize(id, token);
    if (await this.queue.getJob(id)) {
      await this.redis.zrem(`${this.config.prefix}:admission-pending`, id);
      return this.status(id, token);
    }
    const info = await this.config.store.head(uploadKey(id, uploadKind(r.name)!));
    if (!info) throw new PipelineError(409, 'Upload has not finished.');
    if (info.bytes !== r.bytes)
      throw new PipelineError(400, 'Upload size does not match.');
    // Expired ticket leases must reacquire capacity before queueing. Keep this
    // reservation if a queue command times out: it can still arrive later.
    await reserveAdmission(this.redis, this.queue, this.config.prefix, id, 'complete');
    // Job id makes repeated completion requests idempotent. One global analysis
    // slot makes cache publication/reuse deterministic across worker processes.
    await this.queue.setGlobalConcurrency(1);
    await this.queue.add('analyze-app', r, { jobId: id });
    await this.redis.zrem(`${this.config.prefix}:admission-pending`, id);
    return this.status(id, token);
  }
  async status(id: string, token: string): Promise<JobStatus> {
    const record = await this.authorize(id, token);
    let job = await this.queue.getJob(id);
    if (!job) return { jobId: id, uploadName: record.name, status: 'awaiting-upload' };
    const state = await job.getState();
    // A fast cache hit can finish between reading the job hash and its state.
    // Terminal results/reasons must come from a snapshot taken after that state.
    if (state === 'completed' || state === 'failed') {
      job = await this.queue.getJob(id);
      if (!job) throw new PipelineError(404, 'Job not found or expired.');
    }
    if (state === 'completed' && !job.returnvalue) throw new PipelineError(409, 'Analysis is not ready.');
    if (state === 'completed')
      return {
        jobId: id,
        status: 'succeeded',
        uploadName: record.name,
        projectId: job.returnvalue.projectId,
        cacheHit: job.returnvalue.cacheHit,
      };
    const p = job.progress;
    const progress =
      typeof p === 'object' && p !== null && 'phase' in p && 'message' in p
        ? {
            phase: String(p.phase).slice(0, 120),
            message: String(p.message).slice(0, 300),
          }
        : undefined;
    if (state === 'failed')
      return {
        jobId: id,
        status: 'failed',
        uploadName: record.name,
        ...(progress ? { progress } : {}),
        ...(job.failedReason === 'Analysis failed (timeout).'
          ? {
              errorCode: 'timeout' as const,
              error:
                'This app exceeded the analysis time limit. Its upload has been removed; upload it again to retry.',
            }
          : job.failedReason === 'Analysis failed (progress_unavailable).'
            ? { error: 'Analysis lost its queue connection. Its upload has been removed; upload it again to retry.' }
            : job.failedReason === 'Analysis failed (storage_unavailable).'
              ? { error: 'Analysis lost its storage connection. Its upload has been removed; upload it again to retry.' }
            : job.failedReason === 'Analysis failed (input_limit_exceeded).'
              ? { error: 'This app is larger than this server accepts: too many files, or too large once unpacked. It wasn’t analyzed, and its upload has been removed.' }
            : job.failedReason === 'Analysis failed (out_of_memory).'
              ? { error: 'This app needed more memory than one analysis is allowed. Its upload has been removed.' }
            : job.failedReason === 'Analysis failed (output_limit_exceeded).'
              ? { error: 'This app’s map came out larger than the result limit. Its upload has been removed.' }
            : { error: job.failedReason }),
      };
    return {
      jobId: id,
      status: state === 'active' ? 'running' : 'queued',
      uploadName: record.name,
      ...(progress ? { progress } : {}),
    };
  }
  async project(id: string, token: string) {
    await this.authorize(id, token);
    const job = await this.queue.getJob(id);
    if (!job || (await job.getState()) !== 'completed')
      throw new PipelineError(409, 'Analysis is not ready.');
    const finished = job.returnvalue ? job : await this.queue.getJob(id);
    if (!finished?.returnvalue) throw new PipelineError(409, 'Analysis is not ready.');
    return this.config.store.read(finished.returnvalue.resultKey);
  }
  async close() {
    await this.queue.close();
    this.redis.disconnect();
  }
}
