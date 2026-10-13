// Node-only worker boundary. Keep JSON parsing and interpretation in this package.
import { open, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { adaptReaResult, ReaOutputError, type AdapterOptions } from './index.js';

/**
 * The folder `rea extract-artifact` unpacked an archive into (T008: recovery needs single
 * files out of an .asar). REA picks the folder; the caller must delete it afterwards.
 */
export async function extractedArtifactRoot(path: string, maxBytes: number): Promise<string> {
  if ((await stat(path)).size > maxBytes) throw new ReaOutputError('REA extraction result is over its byte limit');
  let raw: { operation?: unknown; parameters?: { output_root?: unknown }; error?: unknown; message?: unknown };
  try { raw = JSON.parse(await readFile(path, 'utf8')) as typeof raw; }
  catch (cause) { throw new ReaOutputError('REA extraction result is not valid JSON', { cause }); }
  if (raw.error !== undefined) throw new ReaOutputError(`REA couldn’t extract the archive: ${String(raw.message ?? raw.error)}`);
  const root = raw.parameters?.output_root;
  if (raw.operation !== 'extract_artifact' || typeof root !== 'string' || !isAbsolute(root) || !basename(root).startsWith('rea-extracted-')) {
    throw new ReaOutputError('REA extraction result has no extraction folder');
  }
  return root;
}

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
