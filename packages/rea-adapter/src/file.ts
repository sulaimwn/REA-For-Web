// Node-only worker boundary. Keep JSON parsing and interpretation in this package.
import { open } from 'node:fs/promises';
import { adaptReaResult, ReaOutputError, type AdapterOptions } from './index.js';

/** Reads a finalized, private REA artifact with a byte cap before adapting it. */
export async function adaptReaFile(path: string, options: AdapterOptions & { maxBytes: number }) {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new ReaOutputError('Invalid REA artifact byte limit');
  }
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > options.maxBytes) {
      throw new ReaOutputError('REA artifact is not a regular file within its byte limit');
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > options.maxBytes) throw new ReaOutputError('REA artifact exceeded its byte limit');
      chunks.push(chunk as Buffer);
    }
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch (cause) { throw new ReaOutputError('REA artifact is not valid UTF-8 JSON', { cause }); }
    return adaptReaResult(raw, options);
  } finally {
    await handle.close();
  }
}
