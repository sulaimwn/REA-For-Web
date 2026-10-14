#!/usr/bin/env node
// rea-studio analyze <app>: runs REA's static analysis on this machine (JavaScript/
// Electron apps, Windows programs, Android APKs; websites load in a browser), converts the result with @rea-studio/rea-adapter,
// and writes a .studio.json file the website opens locally (/open). Nothing is
// uploaded, and REA only reads the app's files; the app is never run.
import { spawn } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { recoverDroppedRelationships, type IsolatedRun } from '@rea-studio/rea-adapter';
import { adaptManagedFiles, adaptReaFile, checkManagedArtifactFile, extractedArtifactRoot, isManagedArtifactFile, managedProjectionInput, reaErrorMessage } from '@rea-studio/rea-adapter/file';
import { collectNativeBundle, ghidraConfigured } from '@rea-studio/rea-adapter/native-session';
import { collectAndroidBundle, jadxConfigured } from '@rea-studio/rea-adapter/android-session';
import type { StudioNode, StudioProject } from '@rea-studio/schema';
import { findChrome, openPage } from './browser.js';
import { pipeBoundedOutput } from './output.js';

const USAGE = `Usage: rea-studio analyze <app> [--out <file>] [--max-heap-mb <n>] [--no-recover]

  <app>            An extracted Electron/JS app directory, an .asar file,
                   a Windows program (.exe or .dll: .NET, or native with
                   GHIDRA_INSTALL_DIR set), a Linux (ELF) or macOS
                   (Mach-O, single architecture) program (with
                   GHIDRA_INSTALL_DIR set, on a Linux or macOS machine),
                   an Android app (.apk, with REA_JADX_MCP_JAR set), or a
                   website (https://…, opened in a headless Chrome with a
                   throwaway profile).
  --out <file>     Where to write the project (default: <app name>.studio.json).
  --max-heap-mb    Heap for REA's JavaScript analyzer workers (REA default: 1024).
  --no-recover     Skip re-analyzing files whose relationships REA's whole-app
                   result budget dropped (faster, less complete for big apps).

Then open the file at /open on the REA for Web site. It stays on your machine.`;

/** What kind of REA analysis the input needs. */
type TargetKind = 'javascript' | 'managed' | 'elf' | 'macho' | 'android' | 'web';
const MANAGED_EXTENSIONS = new Set(['.exe', '.dll']);

/** Linux programs and shared libraries usually have no extension; recognize them by their header. */
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
/** Thin Mach-O, 32- and 64-bit, in either byte order. */
const MACHO_MAGICS = ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface'].map((hex) => Buffer.from(hex, 'hex'));

/** A Linux (ELF) or macOS (thin Mach-O) program, by its header; `fat-macho` for a universal macOS binary. */
function programHeader(path: string): 'elf' | 'macho' | 'fat-macho' | null {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(8);
    const read = readSync(fd, head, 0, 8, 0);
    const magic = head.subarray(0, 4);
    if (read >= 4 && magic.equals(ELF_MAGIC)) return 'elf';
    if (read >= 4 && MACHO_MAGICS.some((m) => magic.equals(m))) return 'macho';
    // 0xCAFEBABE also starts Java class files, whose next field (minor, major version) reads as 45 or more.
    const archs = read === 8 ? head.readUInt32BE(4) : 0;
    if (head.readUInt32BE(0) === 0xcafebabe && archs > 0 && archs < 45) return 'fat-macho';
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Raw REA output this large can't be parsed as one JavaScript string anyway. */
const MAX_REA_OUTPUT_BYTES = 1024 * 1024 * 1024;

class CliError extends Error {}

interface Options {
  target: string;
  kind: TargetKind;
  out: string;
  maxHeapMb: string | null;
  /** Re-analyze files whose relationships the whole-app run dropped (T008). */
  recover: boolean;
}

/** Isolated REA runs at once during recovery. Each can use about 1 GB of memory on big files. */
const RECOVERY_CONCURRENCY = 2;

function parseArgs(argv: string[]): Options {
  const [command, ...rest] = argv;
  if (command !== 'analyze' || rest.includes('--help') || rest.includes('-h')) throw new CliError(USAGE);
  // `npm run analyze -w rea-studio -- <app>` runs in apps/cli; resolve paths from where the user ran npm.
  const cwd = process.env['INIT_CWD'] ?? process.cwd();
  let target: string | null = null;
  let out: string | null = null;
  let maxHeapMb: string | null = null;
  let recover = true;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === '--no-recover') recover = false;
    else if (arg === '--out' || arg === '--max-heap-mb') {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new CliError(`${arg} needs a value`);
      if (arg === '--out') out = value;
      else maxHeapMb = value;
    }
    else if (arg.startsWith('--')) throw new CliError(`Unknown option ${arg}\n\n${USAGE}`);
    else if (target === null) target = arg;
    else throw new CliError(`Unexpected argument ${arg}\n\n${USAGE}`);
  }
  if (target === null) throw new CliError(USAGE);
  if (maxHeapMb !== null && (!/^\d+$/.test(maxHeapMb) || !Number.isSafeInteger(Number(maxHeapMb)) || Number(maxHeapMb) < 1)) {
    throw new CliError('--max-heap-mb must be a positive whole number');
  }
  if (/^https?:\/\//iu.test(target)) {
    let url: URL;
    try { url = new URL(target); } catch { throw new CliError(`Not a valid URL: ${target}`); }
    const name = url.host.replace(/[^a-z0-9.-]+/giu, '-') || 'site';
    return { target: url.href, kind: 'web', out: resolve(cwd, out ?? `${name}.studio.json`), maxHeapMb, recover };
  }
  const abs = resolve(cwd, target);
  if (!existsSync(abs)) throw new CliError(`Not found: ${abs}`);
  const isDir = statSync(abs).isDirectory();
  const ext = isDir ? '' : extname(abs).toLowerCase();
  const program = !isDir && ext !== '.asar' && ext !== '.apk' && !MANAGED_EXTENSIONS.has(ext) ? programHeader(abs) : null;
  if (program === 'fat-macho') {
    throw new CliError('This is a universal (multi-architecture) macOS program, which isn’t supported yet. Analyze one architecture: on a Mac, `lipo <program> -thin x86_64 -output <program>-x86_64` (or arm64).');
  }
  if (!isDir && !program && ext !== '.asar' && ext !== '.apk' && !MANAGED_EXTENSIONS.has(ext)) {
    throw new CliError('The app must be a directory, an .asar file, an .exe/.dll program, a Linux (ELF) or macOS (Mach-O) program or an .apk.');
  }
  const name = basename(abs, isDir ? '' : extname(abs)) || 'app';
  const kind: TargetKind = program ?? (MANAGED_EXTENSIONS.has(ext) ? 'managed' : ext === '.apk' ? 'android' : 'javascript');
  return { target: abs, kind, out: resolve(cwd, out ?? `${name}.studio.json`), maxHeapMb, recover };
}

function reaInstall(): { script: string; version: string } {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('rea-agents/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return { script: join(dirname(pkgPath), 'scripts', 'rea.mjs'), version: pkg.version };
}

/** Runs one REA command, streaming stdout to a file and (unless quiet) showing its stderr progress events. */
async function runRea(script: string, command: string[], outFile: string, quiet = false): Promise<void> {
  const args = [script, ...command, '--format', 'json'];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<number | null>((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('close', resolvePromise);
    });
    const captured = pipeBoundedOutput(child.stdout, createWriteStream(outFile), MAX_REA_OUTPUT_BYTES)
      .catch((error: unknown) => {
        child.kill();
        throw error;
      });
    const otherStderr: string[] = [];
    const tty = process.stderr.isTTY && !quiet;
    createInterface({ input: child.stderr }).on('line', (line) => {
      let message: string | null = null;
      try {
        const ev = JSON.parse(line) as { rea_progress?: { message?: string } };
        message = ev.rea_progress?.message ?? null;
      } catch {
        // Not a progress event.
      }
      if (message === null) {
        otherStderr.push(line);
        if (otherStderr.length > 40) otherStderr.shift();
      } else if (quiet) {
        // Parallel recovery runs report their own progress.
      } else if (tty) {
        process.stderr.write(`\r\x1b[2K  ${message.slice(0, (process.stderr.columns ?? 100) - 4)}`);
      } else {
        process.stderr.write(`  ${message}\n`);
      }
    });
    try {
      // Wait for both streams and the process, even if a disk/size error kills REA.
      const [output, exit] = await Promise.allSettled([captured, exited]);
      if (output.status === 'rejected') throw output.reason;
      if (exit.status === 'rejected') throw exit.reason;
      if (exit.value !== 0) {
        const reason = await reaErrorMessage(outFile, MAX_REA_OUTPUT_BYTES);
        throw new CliError(`REA couldn’t analyze this file${reason ? `: ${reason}` : ` (exit code ${exit.value})`}.\n${otherStderr.join('\n')}`.trimEnd());
      }
    } finally {
      if (tty) process.stderr.write('\r\x1b[2K');
    }
}

/**
 * T008: REA's shared whole-app result budget drops the relationships of many files in big apps.
 * Re-analyze each such file on its own (with its .map and the root package.json at the same
 * relative paths) and merge what it finds. An .asar is unpacked once with REA's own extractor.
 */
async function recoverDropped(script: string, opts: Options, project: StudioProject, work: string): Promise<{ project: StudioProject; recovered: number; failed: number }> {
  const files = project.nodes
    .filter((n): n is Extract<StudioNode, { kind: 'file' }> => n.kind === 'file' && n.analysisIssue !== null && n.path !== '')
    // Paths come from REA's output; never let one escape the scratch folder.
    .filter((n) => !isAbsolute(n.path) && !n.path.split(/[\\/]/).includes('..'))
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  if (files.length === 0) return { project, recovered: 0, failed: 0 };
  process.stderr.write(`REA's whole-app result budget dropped the relationships of ${files.length} files; re-analyzing each on its own (--no-recover skips this)\n`);

  let appDir = opts.target;
  let extracted: string | null = null;
  try {
    if (!statSync(opts.target).isDirectory()) {
      const result = join(work, 'extract.json');
      await runRea(script, ['extract-artifact', opts.target], result, true);
      extracted = await extractedArtifactRoot(result, MAX_REA_OUTPUT_BYTES);
      appDir = extracted;
    }
    const runs: IsolatedRun[] = [];
    let failed = 0;
    let done = 0;
    const queue = [...files];
    await Promise.all(Array.from({ length: RECOVERY_CONCURRENCY }, async (_, worker) => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        const dir = await mkdtemp(join(work, `isolated-${worker}-`));
        try {
          for (const rel of ['package.json', file.path, `${file.path}.map`]) {
            const from = join(appDir, rel);
            if (!existsSync(from)) continue;
            await mkdir(dirname(join(dir, rel)), { recursive: true });
            await copyFile(from, join(dir, rel));
          }
          const out = join(work, `isolated-${worker}.json`);
          await runRea(script, ['analyze-javascript-application', dir, ...(opts.maxHeapMb ? ['--max-heap-mb', opts.maxHeapMb] : [])], out, true);
          const { project: isolated } = await adaptReaFile(out, { reaVersion: project.analysis.engine.version, maxBytes: MAX_REA_OUTPUT_BYTES });
          runs.push({ path: file.path, project: isolated });
        } catch {
          failed++; // that file keeps its whole-app facts only
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
        done++;
        process.stderr.write(process.stderr.isTTY ? `\r\x1b[2K  re-analyzed ${done}/${files.length}` : `  re-analyzed ${done}/${files.length}: ${file.path}\n`);
      }
    }));
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[2K');
    const merged = recoverDroppedRelationships(project, runs);
    return { project: merged.project, recovered: merged.report.recoveredFiles.length, failed: failed + merged.report.skipped.length };
  } finally {
    if (extracted) await rm(extracted, { recursive: true, force: true });
  }
}

function summarize(project: StudioProject, outFile: string, seconds: number, recovery: { recovered: number; failed: number } | null = null): string {
  const t = project.target;
  const a = project.analysis;
  const lines = [
    `${t.name}${t.version ? ` v${t.version}` : ''} (${t.appKind}) · ${a.coverage.status} coverage · ${seconds.toFixed(1)}s`,
    `${project.nodes.length.toLocaleString()} nodes · ${project.edges.length.toLocaleString()} links`,
    '',
  ];
  for (const f of project.findings) {
    const count = f.status === 'found' ? String(f.count) : 'not found';
    const extra = f.unresolvedCount > 0 ? ` (${f.unresolvedCount} unresolved)` : '';
    lines.push(`  ${f.category.padEnd(15)} ${count}${extra}`);
  }
  if (recovery) {
    lines.push('', `  Re-analyzed ${recovery.recovered} files on their own to recover relationships REA's whole-app budget dropped${recovery.failed > 0 ? ` (${recovery.failed} couldn't be)` : ''}.`);
  }
  if (a.filesWithAnalysisIssues > 0) lines.push('', `  ${a.filesWithAnalysisIssues} files lost relationship details to REA resource limits.`);
  lines.push('', `Wrote ${outFile}`, 'Open it at /open on the REA for Web site (or `npm run dev` → http://localhost:3000/open).');
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rea = reaInstall();
  // Reserve the destination before analysis. Never truncate an existing file,
  // including when --out accidentally names the app being analyzed.
  const destination = await open(opts.out, 'wx').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new CliError(`Output already exists: ${opts.out}. Choose a new --out path.`);
    throw error;
  });
  let complete = false;
  let work: string | undefined;
  try {
    work = await mkdtemp(join(tmpdir(), 'rea-studio-'));
    process.stderr.write(opts.kind === 'web'
      ? `Opening ${opts.target} in a headless Chrome (throwaway profile) and analyzing its scripts with rea-agents@${rea.version}\n`
      : `Analyzing ${opts.target} with rea-agents@${rea.version} (static analysis; the app is not run)\n`);
    const started = Date.now();
    const adapterOptions = { reaVersion: rea.version, targetName: opts.kind === 'web' ? new URL(opts.target).host : basename(opts.target), maxBytes: MAX_REA_OUTPUT_BYTES };
    let project: StudioProject;
    let recovery: { recovered: number; failed: number } | null = null;
    if (opts.kind === 'web') {
      // Websites: the page loads in Chrome like a normal visit; REA captures and statically analyzes its scripts.
      const chrome = findChrome();
      if (!chrome) throw new CliError('Website analysis needs Google Chrome or Chromium. Install it, or set CHROME_PATH.');
      const browser = await openPage(chrome, opts.target);
      try {
        const raw = join(work, 'web-bundle.json');
        await runRea(rea.script, ['analyze-web-bundle', browser.endpoint, browser.targetId, '--observation-ms', '3000'], raw);
        ({ project } = await adaptReaFile(raw, adapterOptions));
      } finally {
        await browser.close();
      }
    } else if (opts.kind === 'managed') {
      // .NET: three read-only metadata inspections, then REA's projection of them into a graph.
      const files = {
        artifact: join(work, 'managed-artifact.json'),
        members: join(work, 'managed-members.json'),
        boundaries: join(work, 'managed-native-boundaries.json'),
        projection: join(work, 'managed-graph.json'),
      };
      await runRea(rea.script, ['inspect-managed-artifact', opts.target], files.artifact);
      if (!(await isManagedArtifactFile(files.artifact, MAX_REA_OUTPUT_BYTES)) && ghidraConfigured()) {
        // A native program: REA's Ghidra provider maps its functions, imports, calls and strings.
        process.stderr.write('  native program: analyzing with Ghidra through REA\n');
        const bundle = join(work, 'native-bundle.json');
        await writeFile(bundle, JSON.stringify(await collectNativeBundle({
          reaScript: rea.script, program: opts.target, onProgress: (m) => process.stderr.write(`  ${m}\n`),
        })));
        ({ project } = await adaptReaFile(bundle, adapterOptions));
      } else {
        await checkManagedArtifactFile(files.artifact, MAX_REA_OUTPUT_BYTES); // a native .exe without Ghidra stops here
        await runRea(rea.script, ['inspect-managed-members', opts.target], files.members);
        await runRea(rea.script, ['inspect-managed-native-boundaries', opts.target], files.boundaries);
        const input = join(work, 'managed-graph-input.json');
        await writeFile(input, await managedProjectionInput(files, MAX_REA_OUTPUT_BYTES));
        await runRea(rea.script, ['project-managed-application-graph', input], files.projection);
        ({ project } = await adaptManagedFiles(files, adapterOptions));
      }
    } else if (opts.kind === 'elf' || opts.kind === 'macho') {
      // Linux and macOS programs: REA's Ghidra provider, which reads ELF and Mach-O only on Linux/macOS hosts.
      const what = opts.kind === 'elf' ? 'Linux (ELF)' : 'macOS (Mach-O)';
      if (process.platform === 'win32') {
        throw new CliError(`${what} programs need REA’s Ghidra on a Linux or macOS machine: on Windows, REA’s Ghidra provider reads only Windows programs. The analysis worker (native image) can read them.`);
      }
      if (!ghidraConfigured()) throw new CliError(`${what} programs need REA’s Ghidra provider: set GHIDRA_INSTALL_DIR to Ghidra 12.1.x (and have a JDK 21).`);
      const bundle = join(work, 'native-bundle.json');
      await writeFile(bundle, JSON.stringify(await collectNativeBundle({
        reaScript: rea.script, program: opts.target, onProgress: (m) => process.stderr.write(`  ${m}\n`),
      })));
      ({ project } = await adaptReaFile(bundle, adapterOptions));
    } else if (opts.kind === 'android') {
      // Android: REA's JADX provider reads the manifest, the app's classes and their decompiled code.
      if (!jadxConfigured()) {
        throw new CliError('Android apps need REA’s JADX provider: set REA_JADX_MCP_JAR to a jadx-headless-mcp 0.7.1 JAR (and have a JDK). REA doesn’t download it.');
      }
      const bundle = join(work, 'android-bundle.json');
      await writeFile(bundle, JSON.stringify(await collectAndroidBundle({
        reaScript: rea.script, apk: opts.target, onProgress: (m) => process.stderr.write(`  ${m}\n`),
      })));
      ({ project } = await adaptReaFile(bundle, adapterOptions));
    } else {
      const raw = join(work, 'rea-output.json');
      const command = ['analyze-javascript-application', opts.target];
      if (opts.maxHeapMb) command.push('--max-heap-mb', opts.maxHeapMb);
      await runRea(rea.script, command, raw);
      ({ project } = await adaptReaFile(raw, adapterOptions));
      if (opts.recover) {
        const r = await recoverDropped(rea.script, opts, project, work);
        project = r.project;
        if (r.recovered + r.failed > 0) recovery = r;
      }
    }
    await destination.writeFile(JSON.stringify(project));
    complete = true;
    process.stdout.write(`${summarize(project, opts.out, (Date.now() - started) / 1000, recovery)}\n`);
  } finally {
    await destination.close();
    if (!complete) await rm(opts.out, { force: true });
    if (work) await rm(work, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => {
  // Adapter errors explain the input (e.g. "This is a native program, not .NET"); no stack needed.
  const plain = e instanceof CliError || (e instanceof Error && e.name === 'ReaOutputError');
  process.stderr.write(`${plain ? (e as Error).message : e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exitCode = 1;
});
