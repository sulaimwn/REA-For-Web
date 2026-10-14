import { lstat, open, opendir } from "node:fs/promises";
import { join, extname } from "node:path";
import { WorkerError, type AnalysisLimits } from "./limits.js";
import type { FileHandle } from "node:fs/promises";

/**
 * `exe`/`dll` are Windows programs (PE): .NET assemblies, or native code for the native image.
 * `elf` is a Linux program or shared library, read by REA's Ghidra provider (native image only).
 * `macho` is a single-architecture macOS program or library, read the same way (T035).
 * `apk` is an Android package, read by REA's JADX provider (native image only).
 */
export type TargetKind = "asar" | "directory" | "exe" | "dll" | "elf" | "macho" | "apk";
/** Single files read by REA's program providers rather than its JavaScript analyzer. */
export const PROGRAM_KINDS: readonly TargetKind[] = ["exe", "dll", "elf", "macho", "apk"];
const SIGNATURES: Partial<Record<TargetKind, { magics: string[]; error: string }>> = {
  exe: { magics: ["MZ"], error: "Not a Windows program (no MZ header)." },
  dll: { magics: ["MZ"], error: "Not a Windows program (no MZ header)." },
  elf: { magics: ["\x7fELF"], error: "Not a Linux program (no ELF header)." },
  // Thin Mach-O, 32/64-bit in either byte order. Universal (0xCAFEBABE) binaries are refused for now.
  macho: {
    magics: ["\xcf\xfa\xed\xfe", "\xce\xfa\xed\xfe", "\xfe\xed\xfa\xcf", "\xfe\xed\xfa\xce"],
    error: "Not a single-architecture macOS program (no thin Mach-O header).",
  },
  apk: { magics: ["PK\x03\x04"], error: "Not an Android package (no ZIP header)." },
};
export const TARGET_KINDS: readonly TargetKind[] = ["asar", "directory", ...PROGRAM_KINDS];
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
  /**
   * One APK ZIP entry. Real apps ship thousands of resources (WhatsApp exceeds 5,000), and JADX
   * never unpacks them all, so entries don't count as app files. They're bounded by the ZIP
   * format (a non-ZIP64 directory lists at most 65,534 entries; ZIP64 is refused), the 8 MiB
   * directory cap and the expanded-byte budget below.
   */
  archiveEntry(expanded: number) {
    if (!Number.isSafeInteger(expanded) || expanded < 0) {
      throw new WorkerError("invalid_input", "Invalid file size.");
    }
    this.entries++;
    this.logicalBytes += expanded;
    if (this.logicalBytes > this.limits.maxInputBytes) {
      throw new WorkerError("input_limit_exceeded", "The APK is too large once unpacked.");
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

// Read ZIP metadata only; never extract APK entries. PKWARE APPNOTE sections 4.3.12/4.3.16:
// https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
// ZIP64, encryption and split archives are outside this bounded upload format.
async function inspectApk(handle: FileHandle, size: number, budget: Budget) {
  const invalid = () => new WorkerError("invalid_input", "Invalid or unsupported APK ZIP directory.");
  const tail = Buffer.alloc(Math.min(size, 22 + 0xffff));
  if ((await handle.read(tail, 0, tail.length, size - tail.length)).bytesRead !== tail.length) throw invalid();
  let end = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (tail.readUInt32LE(at) === 0x06054b50 && at + 22 + tail.readUInt16LE(at + 20) === tail.length) { end = at; break; }
  }
  if (end < 0) throw invalid();
  const count = tail.readUInt16LE(end + 10);
  const bytes = tail.readUInt32LE(end + 12);
  const offset = tail.readUInt32LE(end + 16);
  const endOffset = size - tail.length + end;
  if (tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0
      || count !== tail.readUInt16LE(end + 8) || !count || count === 0xffff
      || bytes === 0xffffffff || offset === 0xffffffff || offset + bytes !== endOffset) throw invalid();
  if (bytes > MAX_HEADER_BYTES) throw new WorkerError("input_limit_exceeded", "APK ZIP directory exceeds its byte limit.");
  const directory = Buffer.alloc(bytes);
  if ((await handle.read(directory, 0, bytes, offset)).bytesRead !== bytes) throw invalid();
  let at = 0;
  for (let entry = 0; entry < count; entry++) {
    if (at + 46 > bytes || directory.readUInt32LE(at) !== 0x02014b50) throw invalid();
    const flags = directory.readUInt16LE(at + 8);
    const compressed = directory.readUInt32LE(at + 20);
    const expanded = directory.readUInt32LE(at + 24);
    const nameBytes = directory.readUInt16LE(at + 28);
    const length = 46 + nameBytes + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
    const localOffset = directory.readUInt32LE(at + 42);
    const mode = (directory.readUInt32LE(at + 38) >>> 16) & 0xf000;
    if (at + length > bytes || !nameBytes || (flags & 1) || directory.readUInt16LE(at + 34) !== 0
        || compressed === 0xffffffff || expanded === 0xffffffff || localOffset + 30 + compressed > offset
        || mode === 0xa000) throw invalid();
    const name = directory.subarray(at + 46, at + 46 + nameBytes).toString("utf8");
    if (/^[\/\\]|[\x00-\x1f\\:]/u.test(name) || name.split("/").some((part) => part === ".." || part === ".")) throw invalid();
    // Expanded sizes bound compressed APKs; see Budget.archiveEntry for the entry bound.
    budget.archiveEntry(expanded);
    at += length;
  }
  if (at !== bytes) throw invalid();
}

/** Check physical bytes and signature, and bound APK entry counts/expanded sizes before REA starts. */
async function inspectProgram(target: string, kind: TargetKind, budget: Budget) {
  const handle = await open(target, "r");
  try {
    const stats = await handle.stat();
    budget.archive(stats.size);
    if (kind !== "apk") budget.file(stats.size, false, true);
    const signature = SIGNATURES[kind]!;
    const head = Buffer.alloc(Math.max(...signature.magics.map(m => m.length)));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const text = head.subarray(0, bytesRead).toString("latin1");
    if (!signature.magics.some(m => text.startsWith(m))) {
      throw new WorkerError("invalid_input", signature.error);
    }
    if (kind === "apk") await inspectApk(handle, stats.size, budget);
  } finally {
    await handle.close();
  }
}

export async function preflightTarget(target: string, kind: TargetKind, limits: AnalysisLimits) {
  const root = await lstat(target);
  if (root.isSymbolicLink() || (kind === "directory" ? !root.isDirectory() : !root.isFile())) {
    throw new WorkerError("invalid_input", "Expected an ordinary file or directory.");
  }
  const budget = new Budget(limits);
  if (PROGRAM_KINDS.includes(kind)) {
    await inspectProgram(target, kind, budget);
  } else if (kind === "asar") {
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
  return { files: budget.files, entries: budget.entries, physicalBytes: budget.physicalBytes, logicalBytes: budget.logicalBytes };
}
