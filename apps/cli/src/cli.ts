#!/usr/bin/env node
// rea-studio analyze <app>: runs REA's static analysis on this machine (JavaScript/
// Electron apps, or .NET programs), converts the result with @rea-studio/rea-adapter,
// and writes a .studio.json file the website opens locally (/open). Nothing is
// uploaded, and REA only reads the app's files; the app is never run.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { adaptManagedFiles, adaptReaFile, checkManagedArtifactFile, managedProjectionInput, reaErrorMessage } from '@rea-studio/rea-adapter/file';
import type { StudioProject } from '@rea-studio/schema';
import { findChrome, openPage } from './browser.js';
import { pipeBoundedOutput } from './output.js';

const USAGE = `Usage: rea-studio analyze <app> [--out <file>] [--max-heap-mb <n>]

  <app>            An extracted Electron/JS app directory, an .asar file,
                   a .NET program (.exe or .dll), or a website (https://…,
                   opened in a headless Chrome with a throwaway profile).
  --out <file>     Where to write the project (default: <app name>.studio.json).
  --max-heap-mb    Heap for REA's JavaScript analyzer workers (REA default: 1024).

Then open the file at /open on the REA for Web site. It stays on your machine.`;

/** What kind of REA analysis the input needs. */
type TargetKind = 'javascript' | 'managed' | 'web';
const MANAGED_EXTENSIONS = new Set(['.exe', '.dll']);

/** Raw REA output this large can't be parsed as one JavaScript string anyway. */
const MAX_REA_OUTPUT_BYTES = 1024 * 1024 * 1024;

class CliError extends Error {}

interface Options {
  target: string;
  kind: TargetKind;
  out: string;
  maxHeapMb: string | null;
}

function parseArgs(argv: string[]): Options {
  const [command, ...rest] = argv;
  if (command !== 'analyze' || rest.includes('--help') || rest.includes('-h')) throw new CliError(USAGE);
  // `npm run analyze -w rea-studio -- <app>` runs in apps/cli; resolve paths from where the user ran npm.
  const cwd = process.env['INIT_CWD'] ?? process.cwd();
  let target: string | null = null;
  let out: string | null = null;
  let maxHeapMb: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === '--out' || arg === '--max-heap-mb') {
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
    return { target: url.href, kind: 'web', out: resolve(cwd, out ?? `${name}.studio.json`), maxHeapMb };
  }
  const abs = resolve(cwd, target);
  if (!existsSync(abs)) throw new CliError(`Not found: ${abs}`);
  const isDir = statSync(abs).isDirectory();
  const ext = isDir ? '' : extname(abs).toLowerCase();
  if (!isDir && ext !== '.asar' && !MANAGED_EXTENSIONS.has(ext)) {
    throw new CliError('The app must be a directory, an .asar file, or a .NET .exe/.dll.');
  }
  const name = basename(abs, isDir ? '' : extname(abs)) || 'app';
  const kind: TargetKind = MANAGED_EXTENSIONS.has(ext) ? 'managed' : 'javascript';
  return { target: abs, kind, out: resolve(cwd, out ?? `${name}.studio.json`), maxHeapMb };
}

function reaInstall(): { script: string; version: string } {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('rea-agents/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return { script: join(dirname(pkgPath), 'scripts', 'rea.mjs'), version: pkg.version };
}

/** Runs one REA command, streaming stdout to a file and showing its stderr progress events. */
async function runRea(script: string, command: string[], outFile: string): Promise<void> {
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
    const tty = process.stderr.isTTY;
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

function summarize(project: StudioProject, outFile: string, seconds: number): string {
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
      await checkManagedArtifactFile(files.artifact, MAX_REA_OUTPUT_BYTES); // e.g. a native .exe stops here
      await runRea(rea.script, ['inspect-managed-members', opts.target], files.members);
      await runRea(rea.script, ['inspect-managed-native-boundaries', opts.target], files.boundaries);
      const input = join(work, 'managed-graph-input.json');
      await writeFile(input, await managedProjectionInput(files, MAX_REA_OUTPUT_BYTES));
      await runRea(rea.script, ['project-managed-application-graph', input], files.projection);
      ({ project } = await adaptManagedFiles(files, adapterOptions));
    } else {
      const raw = join(work, 'rea-output.json');
      const command = ['analyze-javascript-application', opts.target];
      if (opts.maxHeapMb) command.push('--max-heap-mb', opts.maxHeapMb);
      await runRea(rea.script, command, raw);
      ({ project } = await adaptReaFile(raw, adapterOptions));
    }
    await destination.writeFile(JSON.stringify(project));
    complete = true;
    process.stdout.write(`${summarize(project, opts.out, (Date.now() - started) / 1000)}\n`);
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
