import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  PipelineError,
  SIGNED_UPLOAD_SECONDS,
  UPLOAD_TTL_SECONDS,
  uploadKind,
  type UploadKind,
  type UploadRequest,
} from './contracts.js';

export type ObjectInfo = { bytes: number; metadata: Record<string, string> };
export interface ObjectStore {
  kind: 'local' | 'r2';
  signUpload(
    id: string,
    request: UploadRequest,
    origin: string,
  ): Promise<{ url: string; headers: Record<string, string> }>;
  head(key: string): Promise<ObjectInfo | null>;
  read(key: string): Promise<Readable>;
  put(
    key: string,
    path: string,
    metadata: Record<string, string>,
  ): Promise<void>;
  delete(key: string): Promise<void>;
  expireUploads(): Promise<void>;
}
export const uploadKey = (id: string, kind: UploadKind = 'asar') => `uploads/${id}.${kind}`;
export const resultKey = (hash: string, kind: UploadKind = 'asar') =>
  `results/schema-0.1.0-rea-6.4.0-adapter-7/${kind}/${hash}.json.gz`;
function safeKey(key: string) {
  if (
    !/^(uploads\/[a-f0-9-]+\.(?:asar|exe|dll|apk|elf|macho)|results\/schema-0\.1\.0-rea-6\.4\.0-adapter-(?:[23456]\/|7\/(?:asar|exe|dll|apk|elf|macho)\/)[a-f0-9]{64}\.json\.gz)$/u.test(
      key,
    )
  ) {
    throw new PipelineError(400, 'Invalid storage key.');
  }
  return key;
}

export class VerifiedBytes extends Transform {
  private bytes = 0;
  private hash = createHash('sha256');
  constructor(private expected: Pick<UploadRequest, 'bytes' | 'sha256'>) {
    super();
  }
  override _transform(
    chunk: Buffer,
    _: BufferEncoding,
    next: (error?: Error | null, data?: Buffer) => void,
  ) {
    this.bytes += chunk.length;
    if (this.bytes > this.expected.bytes) {
      next(new PipelineError(413, 'Upload exceeds its declared size.'));
      return;
    }
    this.hash.update(chunk);
    next(null, chunk);
  }
  override _flush(next: (error?: Error | null) => void) {
    next(
      this.bytes !== this.expected.bytes ||
        this.hash.digest('hex') !== this.expected.sha256
        ? new PipelineError(400, 'Upload size or SHA-256 does not match.')
        : null,
    );
  }
}

export class LocalStore implements ObjectStore {
  readonly kind = 'local';
  constructor(
    public readonly root: string,
    private secret: string,
  ) {
    if (secret.length < 32)
      throw new Error('Local upload secret must be at least 32 characters.');
    this.root = resolve(root);
  }
  private path(key: string) {
    return join(this.root, safeKey(key));
  }
  private signature(id: string, request: UploadRequest, expiry: number) {
    return createHmac('sha256', this.secret)
      .update(`${id}:${request.bytes}:${request.sha256}:${expiry}`)
      .digest('hex');
  }
  async signUpload(id: string, request: UploadRequest, origin: string) {
    const expiry = Math.floor(Date.now() / 1000) + SIGNED_UPLOAD_SECONDS;
    return {
      url: `${origin}/api/uploads/${id}/file?expires=${expiry}&signature=${this.signature(id, request, expiry)}`,
      headers: { 'Content-Type': 'application/octet-stream' },
    };
  }
  async receive(
    id: string,
    request: UploadRequest,
    expiry: number,
    signature: string,
    body: Readable,
    signal?: AbortSignal,
  ) {
    this.verifyUploadLink(id, request, expiry, signature);
    const kind = uploadKind(request.name);
    if (!kind) throw new PipelineError(400, 'Unsupported upload format.');
    const path = this.path(uploadKey(id, kind));
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.${randomUUID()}.partial`;
    try {
      await pipeline(
        body,
        new VerifiedBytes(request),
        createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
      await rename(partial, path);
    } finally {
      await rm(partial, { force: true });
    }
  }
  verifyUploadLink(id: string, request: UploadRequest, expiry: number, signature: string) {
    const expected = this.signature(id, request, expiry);
    if (
      !Number.isSafeInteger(expiry) ||
      expiry <= Date.now() / 1000 ||
      expiry > Date.now() / 1000 + SIGNED_UPLOAD_SECONDS + 5 ||
      !/^[a-f0-9]{64}$/u.test(signature) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    ) {
      throw new PipelineError(403, 'Upload link has expired or is invalid.');
    }
  }
  async head(key: string) {
    try {
      const path = this.path(key);
      const s = await stat(path);
      let metadata: Record<string, string> = {};
      if (key.startsWith('results/'))
        metadata = JSON.parse(
          await (
            await import('node:fs/promises')
          ).readFile(`${path}.meta`, 'utf8'),
        );
      return { bytes: s.size, metadata };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async read(key: string) {
    return createReadStream(this.path(key));
  }
  async put(key: string, path: string, metadata: Record<string, string>) {
    const dest = this.path(key);
    await mkdir(dirname(dest), { recursive: true });
    const partial = `${dest}.${randomUUID()}.partial`;
    try {
      await pipeline(
        createReadStream(path),
        createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
      );
      await rename(partial, dest);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(`${dest}.meta`, JSON.stringify(metadata), {
        mode: 0o600,
      });
    } finally {
      await rm(partial, { force: true });
    }
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
  async expireUploads() {
    const root = join(this.root, 'uploads');
    const files = await readdir(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of files) {
      if (!/^[a-f0-9-]+\.(?:asar|exe|dll|apk|elf|macho)(?:\.[a-f0-9-]+\.partial)?$/u.test(name)) continue;
      const path = join(root, name);
      if ((await stat(path)).mtimeMs < Date.now() - UPLOAD_TTL_SECONDS * 1000)
        await rm(path, { force: true });
    }
  }
}

export class R2Store implements ObjectStore {
  readonly kind = 'r2';
  constructor(
    private client: S3Client,
    private bucket: string,
    private requestTimeoutMs = 60000,
  ) {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1)
      throw new Error('Invalid storage request deadline.');
  }
  private async request<T>(
    send: (signal: AbortSignal) => Promise<T>,
    responseBody?: (value: T) => Readable,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let body: Readable | undefined;
    try {
      // SDK retry backoff does not immediately respond to abort. Settle our
      // caller on time as well as canceling any current/future HTTP attempt.
      const value = await Promise.race([
        send(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = Object.assign(new Error('Object storage request timed out.'), {
              code: 'storage_unavailable',
            });
            // GET resolves at headers. Fail its stream with our sanitized code
            // before aborting the HTTP request can replace it with ECONNRESET.
            body?.destroy(error);
            controller.abort();
            reject(error);
          }, this.requestTimeoutMs);
        }),
      ]);
      if (responseBody) {
        body = responseBody(value);
        const finish = () => clearTimeout(timer);
        body.once('end', finish).once('close', finish).once('error', finish);
        if (body.readableEnded || body.destroyed) finish();
      }
      return value;
    } catch (error) {
      if (['AbortError', 'TimeoutError'].includes((error as Error).name))
        throw Object.assign(new Error('Object storage request timed out.'), {
          code: 'storage_unavailable',
        });
      throw error;
    } finally {
      // A GET body retains the same deadline through consumption, including
      // time already spent acquiring headers or retrying. Other calls settle here.
      if (!body) clearTimeout(timer);
    }
  }
  async signUpload(id: string, request: UploadRequest, _origin: string) {
    const kind = uploadKind(request.name);
    if (!kind) throw new PipelineError(400, 'Unsupported upload format.');
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: safeKey(uploadKey(id, kind)),
      ContentType: 'application/octet-stream',
      ContentLength: request.bytes,
    });
    return {
      url: await getSignedUrl(this.client, command, {
        expiresIn: SIGNED_UPLOAD_SECONDS,
        signableHeaders: new Set(['content-type', 'content-length']),
      }),
      headers: { 'Content-Type': 'application/octet-stream' },
    };
  }
  async head(key: string) {
    try {
      const v = await this.request((abortSignal) => this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }),
        { abortSignal },
      ));
      return { bytes: v.ContentLength ?? 0, metadata: v.Metadata ?? {} };
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode === 404
      )
        return null;
      throw error;
    }
  }
  async read(key: string) {
    let body: Readable | undefined;
    await this.request((abortSignal) => this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }),
      { abortSignal },
    ), (response) => {
      if (!(response.Body instanceof Readable))
        throw new Error('Object storage did not return a stream.');
      body = response.Body;
      return body;
    });
    return body!;
  }
  async put(key: string, path: string, metadata: Record<string, string>) {
    const bytes = (await stat(path)).size;
    const body = createReadStream(path);
    try {
      await this.request((abortSignal) => this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: safeKey(key),
          Body: body,
          ContentLength: bytes,
          ContentType: 'application/gzip',
          Metadata: metadata,
        }),
        { abortSignal },
      ));
    } finally {
      body.destroy();
    }
  }
  async delete(key: string) {
    await this.request((abortSignal) => this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }),
      { abortSignal },
    ));
  }
  async expireUploads() {
    let token: string | undefined;
    do {
      const page = await this.request((abortSignal) => this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: 'uploads/',
          ...(token ? { ContinuationToken: token } : {}),
        }),
        { abortSignal },
      ));
      for (const object of page.Contents ?? [])
        if (
          object.Key &&
          object.LastModified &&
          object.LastModified.getTime() < Date.now() - UPLOAD_TTL_SECONDS * 1000
        )
          await this.delete(object.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}
