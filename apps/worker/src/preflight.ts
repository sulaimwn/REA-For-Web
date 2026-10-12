import { lstat, open, opendir } from "node:fs/promises";
import { join, extname } from "node:path";
import { WorkerError, type AnalysisLimits } from "./limits.js";

export type TargetKind = "asar" | "directory";
const MAX_HEADER_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 64;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class Budget {
  files = 0;
  entries = 0;
  physicalBytes = 0;
  logicalBytes = 0;
  constructor(private limits: AnalysisLimits) {}
  get maxEntries() { return this.limits.maxFiles * 2 + MAX_DEPTH; }
  entry(depth: number) {
    if (++this.entries > this.maxEntries || depth > MAX_DEPTH) {
      throw new WorkerError("input_limit_exceeded", "Too many entries or directory nesting levels.");
    }
  }
  file(size: number, physical: boolean, logical: boolean) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new WorkerError("invalid_input", "Invalid file size.");
    }
    this.files++;
    if (physical) this.physicalBytes += size;
    if (logical) this.logicalBytes += size;
    if (this.files > this.limits.maxFiles || this.physicalBytes > this.limits.maxInputBytes ||
        this.logicalBytes > this.limits.maxInputBytes) {
      throw new WorkerError("input_limit_exceeded", "Input file count or byte limit exceeded.");
    }
  }
  archive(size: number) {
    this.physicalBytes += size;
    if (this.physicalBytes > this.limits.maxInputBytes) {
      throw new WorkerError("input_limit_exceeded", "Input byte limit exceeded.");
    }
  }
}

// ASAR is two Chromium pickles followed by file bytes. Read only a bounded header,
// using the framing in electron/asar's disk.ts and pickle.ts; never extract files.
async function inspectAsar(target: string, budget: Budget, depth: number) {
  const handle = await open(target, "r");
  try {
    const stats = await handle.stat();
    const prefix = Buffer.alloc(8);
    if ((await handle.read(prefix, 0, 8, 0)).bytesRead !== 8 || prefix.readUInt32LE(0) !== 4) {
      throw new WorkerError("invalid_input", "Invalid ASAR size pickle.");
    }
    const headerSize = prefix.readUInt32LE(4);
    if (headerSize < 8 || headerSize > MAX_HEADER_BYTES || headerSize > stats.size - 8) {
      throw new WorkerError("input_limit_exceeded", "Invalid or oversized ASAR header.");
    }
    const header = Buffer.alloc(headerSize);
    if ((await handle.read(header, 0, headerSize, 8)).bytesRead !== headerSize) {
      throw new WorkerError("invalid_input", "Truncated ASAR header.");
    }
    const payloadSize = header.readUInt32LE(0);
    const jsonSize = header.readUInt32LE(4);
    if (payloadSize !== headerSize - 4 || jsonSize > headerSize - 8) {
      throw new WorkerError("invalid_input", "Invalid ASAR header pickle.");
    }
    let root: unknown;
    try {
      root = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(header.subarray(8, 8 + jsonSize)));
    } catch {
      throw new WorkerError("invalid_input", "Invalid ASAR header JSON.");
    }
    if (!record(root) || !record(root.files)) {
      throw new WorkerError("invalid_input", "ASAR root must contain files.");
    }
    const stack: { entry: unknown; depth: number }[] = [{ entry: root, depth }];
    while (stack.length) {
      const item = stack.pop()!;
      budget.entry(item.depth);
      const entry = item.entry;
      if (!record(entry) || "link" in entry || entry.unpacked === true) {
        throw new WorkerError("invalid_input", "ASAR links and external unpacked entries are unsupported.");
      }
      if ("files" in entry) {
        if (!record(entry.files)) throw new WorkerError("invalid_input", "Invalid ASAR directory.");
        for (const [name, child] of Object.entries(entry.files)) {
          if (!name || name === "." || name === ".." || /[\x00-\x1f\\/:]/u.test(name)) {
            throw new WorkerError("invalid_input", "Unsafe ASAR entry name.");
          }
          if (name.toLowerCase().endsWith(".asar")) {
            throw new WorkerError("invalid_input", "ASAR archives nested inside another archive are unsupported.");
          }
          if (stack.length + budget.entries >= budget.maxEntries) {
            throw new WorkerError("input_limit_exceeded", "Too many ASAR entries.");
          }
          stack.push({ entry: child, depth: item.depth + 1 });
        }
      } else {
        if (typeof entry.size !== "number" || typeof entry.offset !== "string" || !/^\d+$/u.test(entry.offset)) {
          throw new WorkerError("invalid_input", "Invalid ASAR file record.");
        }
        const offset = Number(entry.offset);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(entry.size) ||
            entry.size < 0 || offset + entry.size > stats.size - 8 - headerSize) {
          throw new WorkerError("invalid_input", "ASAR file extends beyond the archive.");
        }
        budget.file(entry.size, false, true);
      }
    }
  } finally {
    await handle.close();
  }
}

export async function preflightTarget(target: string, kind: TargetKind, limits: AnalysisLimits) {
  const root = await lstat(target);
  if (root.isSymbolicLink() || (kind === "asar" ? !root.isFile() : !root.isDirectory())) {
    throw new WorkerError("invalid_input", "Expected an ordinary ASAR file or directory.");
  }
  const budget = new Budget(limits);
  if (kind === "asar") {
    budget.archive(root.size);
    await inspectAsar(target, budget, 0);
  } else {
    const stack = [{ path: target, depth: 0 }];
    budget.entry(0);
    while (stack.length) {
      const item = stack.pop()!;
      const dir = await opendir(item.path);
      for await (const entry of dir) {
        const child = join(item.path, entry.name);
        const stats = await lstat(child);
        budget.entry(item.depth + 1);
        if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
          throw new WorkerError("invalid_input", "Links and special files are unsupported.");
        }
        if (stats.isDirectory()) {
          stack.push({ path: child, depth: item.depth + 1 });
        } else {
          const archive = extname(entry.name).toLowerCase() === ".asar";
          if (archive) budget.archive(stats.size);
          else budget.file(stats.size, true, true);
          if (archive) await inspectAsar(child, budget, item.depth + 1);
        }
      }
    }
  }
  return { files: budget.files, physicalBytes: budget.physicalBytes, logicalBytes: budget.logicalBytes };
}
