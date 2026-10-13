import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, readdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Worker, type Job } from 'bullmq';
import { VerifiedBytes, uploadKey, resultKey } from './storage.js';
import type { PipelineConfig, UploadRecord, JobResult } from './server.js';
import { UPLOAD_TTL_SECONDS, uploadKind, validateUpload, validateJobId } from './contracts.js';

// Worker Redis connections retry indefinitely; a progress command must not
// prevent raw/staging cleanup when the queue is unavailable.
const PROGRESS_WRITE_TIMEOUT_MS = 5000;
async function persistProgress(write: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      write(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(
          new Error('Queue progress persistence timed out.'),
          { code: 'progress_unavailable' },
        )), PROGRESS_WRITE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type AnalysisRunner = (options: {
  targetPath: string;
  targetName: string;
  outputRoot: string;
  onProgress: (value: { phase: string; message: string }) => void;
}) => Promise<{ projectPath: string; projectId: string }>;
export function startAnalysisWorker(
  config: PipelineConfig,
  analyze: AnalysisRunner,
) {
  const worker = new Worker<UploadRecord, JobResult>(
    'analysis',
    (job) => processUpload(config, job, analyze),
    {
      connection: { url: config.redisUrl, maxRetriesPerRequest: null },
      prefix: config.prefix,
      concurrency: 1,
      lockDuration: 60000,
      maxStalledCount: 0,
    },
  );
  worker.on('error', () => {});
  return worker;
}
export async function processUpload(
  config: PipelineConfig,
  job: Pick<Job<UploadRecord, JobResult>, 'data' | 'updateProgress'>,
  analyze: AnalysisRunner,
): Promise<JobResult> {
  const r = job.data;
  const request = validateUpload(r);
  validateJobId(r.id);
  const kind = uploadKind(request.name)!;
  const root = resolve(config.workRoot);
  await mkdir(root, { recursive: true });
  const temp = await mkdtemp(join(root, 'upload-'));
  const targetName = `target.${kind}`;
  const target = join(temp, targetName);
  const key = resultKey(r.sha256, kind);
  let progressPending = Promise.resolve();
  try {
    if (r.createdAt < Date.now() - UPLOAD_TTL_SECONDS * 1000)
      throw Object.assign(new Error('Upload expired.'), {
        code: 'upload_expired',
      });
    // Never reuse a cached project until downloaded bytes prove possession of
    // the requested hash. Uploaded SHA and REA's subject id remain distinct.
    await pipeline(
      await config.store.read(uploadKey(r.id, kind)),
      new VerifiedBytes(r),
      createWriteStream(target, { flags: 'wx', mode: 0o600 }),
      { signal: AbortSignal.timeout(60000) },
    );
    const cache = await config.store.head(key);
    if (
      cache &&
      cache.metadata.uploadsha256 === r.sha256 &&
      /^[a-f0-9]{64}$/u.test(cache.metadata.projectid ?? '')
    )
      return {
        projectId: cache.metadata.projectid!,
        resultKey: key,
        uploadSha256: r.sha256,
        cacheHit: true,
      };
    const artifact = await analyze({
      targetPath: target,
      // Shared cache entries contain artifact facts, never an uploader's label.
      // The authorized job supplies its own filename to the viewer separately.
      targetName,
      outputRoot: join(temp, 'results'),
      onProgress: (progress) => {
        // Serialize bounded progress updates; persist failures before publication.
        progressPending = progressPending.then(() =>
          persistProgress(() => job.updateProgress({
            phase: progress.phase.slice(0, 120),
            message: progress.message.slice(0, 300),
          })),
        );
        void progressPending.catch(() => {});
      },
    });
    await progressPending;
    if (!/^[a-f0-9]{64}$/u.test(artifact.projectId))
      throw new Error('Invalid normalized result receipt.');
    const compressed = join(temp, 'project.json.gz');
    await pipeline(
      createReadStream(artifact.projectPath),
      createGzip(),
      createWriteStream(compressed, { flags: 'wx', mode: 0o600 }),
    );
    await config.store.put(key, compressed, {
      projectid: artifact.projectId,
      uploadsha256: r.sha256,
    });
    return {
      projectId: artifact.projectId,
      resultKey: key,
      uploadSha256: r.sha256,
      cacheHit: false,
    };
  } catch (error) {
    // Redis job failures are exposed to clients: do not include local paths,
    // analyzer stderr, signed URLs, storage credentials or stack traces.
    const code = (error as { code?: unknown }).code;
    throw new Error(
      typeof code === 'string' && /^[a-z_]{1,50}$/u.test(code)
        ? `Analysis failed (${code}).`
        : 'Analysis failed. Check that this is a valid application file.',
    );
  } finally {
    // Wait for all queued writes even when analysis failed; retain raw data
    // only when cleanup itself fails, so the expiry sweep can remove it.
    await progressPending.catch(() => {});
    try {
      await config.store.delete(uploadKey(r.id, kind));
    } catch {
      throw new Error('Raw upload cleanup failed.');
    } finally {
      if (dirname(temp) !== root) throw new Error('Invalid staging directory.');
      await rm(temp, { recursive: true, force: true }).catch(() => {
        throw new Error('Staging cleanup failed.');
      });
    }
  }
}

export async function expireStaging(workRoot: string) {
  const root = resolve(workRoot);
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !/^upload-[a-zA-Z0-9]+$/u.test(entry.name)
    )
      continue;
    const path = join(root, entry.name),
      info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      info.mtimeMs > Date.now() - UPLOAD_TTL_SECONDS * 1000
    )
      continue;
    if (dirname(path) !== root)
      throw new Error('Invalid staging cleanup path.');
    await rm(path, { recursive: true, force: true });
  }
}
