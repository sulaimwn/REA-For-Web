// Node-only worker boundary. Keep JSON parsing and interpretation in this package.
import { open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { adaptReaResult, ReaOutputError, type AdapterOptions } from './index.js';
import { assertManagedArtifact, NOT_MANAGED_MESSAGE } from './managed.js';
import { tmpdir } from 'node:os';

/** Reads a finalized, private REA output file as JSON, with a byte cap. */
async function readReaJson(path: string, maxBytes: number): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new ReaOutputError('Invalid REA artifact byte limit');
  }
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new ReaOutputError('REA artifact is not a regular file within its byte limit');
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new ReaOutputError('REA artifact exceeded its byte limit');
      chunks.push(chunk as Buffer);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch (cause) { throw new ReaOutputError('REA artifact is not valid UTF-8 JSON', { cause }); }
  } finally {
    await handle.close();
  }
}

/** REA's own explanation from a failed command's JSON output (`{ error, code, message }`), if it has one. */
export async function reaErrorMessage(path: string, maxBytes: number): Promise<string | null> {
  try {
    const raw = (await readReaJson(path, maxBytes)) as { error?: unknown; message?: unknown; code?: unknown } | null;
    if (!raw || typeof raw !== 'object' || raw.error === undefined) return null;
    const message = typeof raw.message === 'string' ? raw.message : null;
    const code = typeof raw.code === 'string' ? raw.code : null;
    return [message, code && `(${code})`].filter(Boolean).join(' ') || null;
  } catch {
    return null; // No usable output: the caller reports the exit code alone.
  }
}

/** Reads a finalized, private REA artifact with a byte cap before adapting it. */
export async function adaptReaFile(path: string, options: AdapterOptions & { maxBytes: number }) {
  return adaptReaResult(await readReaJson(path, options.maxBytes), options);
}

/** Output files of REA's managed (.NET) commands for one program (T021). */
export interface ManagedReaFiles {
  /** `rea inspect-managed-artifact` */
  artifact: string;
  /** `rea inspect-managed-members` */
  members: string;
  /** `rea inspect-managed-native-boundaries` */
  boundaries: string;
}

/** True for a .NET program, false for a native one (REA: `not-managed`); throws for anything else REA reported. */
export async function isManagedArtifactFile(path: string, maxBytes: number): Promise<boolean> {
  try {
    assertManagedArtifact(await readReaJson(path, maxBytes));
    return true;
  } catch (error) {
    if (error instanceof ReaOutputError && error.message === NOT_MANAGED_MESSAGE) return false;
    throw error;
  }
}

/** Throws a readable ReaOutputError unless REA classified the file as a .NET program (e.g. a native .exe). */
export async function checkManagedArtifactFile(path: string, maxBytes: number): Promise<void> {
  assertManagedArtifact(await readReaJson(path, maxBytes));
}

/** The JSON input for `rea project-managed-application-graph`, built from the three inspections. */
export async function managedProjectionInput(files: ManagedReaFiles, maxBytes: number): Promise<string> {
  const artifact = await readReaJson(files.artifact, maxBytes);
  assertManagedArtifact(artifact);
  return JSON.stringify({
    managed_artifact: artifact,
    managed_members: await readReaJson(files.members, maxBytes),
    managed_native_boundaries: await readReaJson(files.boundaries, maxBytes),
  });
}

/** Adapts a .NET program from its REA inspection files plus REA's projection of them. */
export async function adaptManagedFiles(files: ManagedReaFiles & { projection: string }, options: AdapterOptions & { maxBytes: number }) {
  return adaptReaResult({
    inspect_managed_artifact: await readReaJson(files.artifact, options.maxBytes),
    inspect_managed_members: await readReaJson(files.members, options.maxBytes),
    inspect_managed_native_boundaries: await readReaJson(files.boundaries, options.maxBytes),
    project_managed_application_graph: await readReaJson(files.projection, options.maxBytes),
  }, options);
}

/**
 * The folder `rea extract-artifact` unpacked an archive into (T008: recovery needs single
 * files out of an .asar). REA picks the folder; the caller must delete it afterwards.
 */
export async function extractedArtifactRoot(path: string, maxBytes: number): Promise<string> {
  const raw = await readReaJson(path, maxBytes) as { operation?: unknown; parameters?: { output_root?: unknown }; error?: unknown; message?: unknown };
  if (!raw || typeof raw !== 'object') throw new ReaOutputError('REA extraction result has no extraction folder');
  if (raw.error !== undefined) throw new ReaOutputError(`REA couldn’t extract the archive: ${String(raw.message ?? raw.error)}`);
  const root = raw.parameters?.output_root;
  const parent = typeof root === 'string' ? resolve(dirname(root)) : '';
  const expectedParent = resolve(tmpdir());
  const sameParent = process.platform === 'win32' ? parent.toLowerCase() === expectedParent.toLowerCase() : parent === expectedParent;
  if (raw.operation !== 'extract_artifact' || typeof root !== 'string' || !isAbsolute(root) || !basename(root).startsWith('rea-extracted-') ||
      !sameParent) {
    throw new ReaOutputError('REA extraction result has no extraction folder');
  }
  return root;
}
