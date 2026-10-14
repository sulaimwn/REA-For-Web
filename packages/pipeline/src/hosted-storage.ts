import { lstat, stat, statfs } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { LocalStore } from './storage.js';
import { MAX_UPLOAD_BYTES, PipelineError, type UploadRequest } from './contracts.js';
import { MAX_PENDING_UPLOADS } from './admission.js';

export const HOSTED_DISK_BYTES = 64n * 1024n ** 3n;
export const MAX_STORED_RESULT_BYTES = 128 * 1024 * 1024;
// Leave enough space for all admitted maximum-size transfers plus one result
// per slot. Actual on-disk capacity, rather than a resettable Redis byte ledger,
// is the final hard bound. Never accept the much larger host/root filesystem.
export const HOSTED_DISK_HEADROOM = BigInt(MAX_PENDING_UPLOADS) *
  BigInt(MAX_UPLOAD_BYTES + MAX_STORED_RESULT_BYTES) + 512n * 1024n ** 2n;
type DiskInfo = { type: bigint; bsize: bigint; blocks: bigint; bavail: bigint };
export function checkHostedDisk(info: DiskInfo, requiredBytes = 0n) {
  if (info.type !== 0xef53n || info.bsize <= 0n || info.blocks <= 0n || info.bavail < 0n ||
    info.blocks * info.bsize > HOSTED_DISK_BYTES)
    throw new PipelineError(503, 'Hosted upload storage is not bounded.');
  if (info.bavail * info.bsize < requiredBytes)
    throw new PipelineError(503, 'Hosted upload storage is full.');
}

export class HostedLocalStore extends LocalStore {
  constructor(root: string, secret: string,
    private probe: (root: string) => Promise<DiskInfo> = path => statfs(path, { bigint: true }),
    private transferTimeoutMs = 10 * 60 * 1000,
  ) {
    super(root, secret);
    if (!Number.isSafeInteger(transferTimeoutMs) || transferTimeoutMs < 1 || transferTimeoutMs > 600000)
      throw new Error('Invalid hosted transfer deadline.');
  }
  async checkCapacity(admission = false) {
    const root = await lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink())
      throw new PipelineError(503, 'Hosted upload storage is unavailable.');
    if (process.platform === 'linux' && ((root.mode & 0o077) !== 0 || root.uid !== process.getuid?.()))
      throw new PipelineError(503, 'Hosted upload storage must be private to its service user.');
    checkHostedDisk(await this.probe(this.root), admission ? HOSTED_DISK_HEADROOM : 0n);
  }
  override async receive(id: string, request: UploadRequest, expiry: number, signature: string, body: Readable) {
    await this.checkCapacity();
    // The route atomically claims the one-use transfer before calling this.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.transferTimeoutMs);
    try {
      await super.receive(id, request, expiry, signature, body, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new PipelineError(408, 'Upload took too long. Choose the file again to retry.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  override async put(key: string, path: string, metadata: Record<string, string>) {
    await this.checkCapacity();
    const bytes = (await stat(path)).size;
    if (bytes > MAX_STORED_RESULT_BYTES || Buffer.byteLength(JSON.stringify(metadata)) > 4096)
      throw new Error('Hosted result exceeds its storage limit.');
    checkHostedDisk(await this.probe(this.root), BigInt(bytes + 4096));
    await super.put(key, path, metadata);
  }
}
