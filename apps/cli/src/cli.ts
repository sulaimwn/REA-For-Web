#!/usr/bin/env node
// rea-studio analyze <app>: runs REA's static JavaScript/Electron analysis on this
// machine, converts the result with @rea-studio/rea-adapter, and writes a
// .studio.json file the website opens locally (/open). Nothing is uploaded, and
// REA only reads the app's files; the app is never run.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { adaptReaFile } from '@rea-studio/rea-adapter/file';
import type { StudioProject } from '@rea-studio/schema';

const USAGE = `Usage: rea-studio analyze <app> [--out <file>] [--max-heap-mb <n>]

  <app>            An extracted Electron/JS app directory, or an .asar file.
  --out <file>     Where to write the project (default: <app name>.studio.json).
  --max-heap-mb    Heap for REA's analyzer workers (REA default: 1024).

Then open the file at /open on the REA Studio site. It stays on your machine.`;

/** Raw REA output this large can't be parsed as one JavaScript string anyway. */
const MAX_REA_OUTPUT_BYTES = 1024 * 1024 * 1024;

class CliError extends Error {}

interface Options {
  target: string;
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
    if (arg === '--out') out = rest[++i] ?? null;
    else if (arg === '--max-heap-mb') maxHeapMb = rest[++i] ?? null;
    else if (arg.startsWith('--')) throw new CliError(`Unknown option ${arg}\n\n${USAGE}`);
    else if (target === null) target = arg;
    else throw new CliError(`Unexpected argument ${arg}\n\n${USAGE}`);
  }
  if (target === null) throw new CliError(USAGE);
  if (maxHeapMb !== null && !/^\d+$/.test(maxHeapMb)) throw new CliError('--max-heap-mb must be a whole number');
  const abs = resolve(cwd, target);
  if (!existsSync(abs)) throw new CliError(`Not found: ${abs}`);
  const isDir = statSync(abs).isDirectory();
  if (!isDir && extname(abs).toLowerCase() !== '.asar') throw new CliError('The app must be a directory or an .asar file.');
  const name = basename(abs, isDir ? '' : '.asar') || 'app';
  return { target: abs, out: resolve(cwd, out ?? `${name}.studio.json`), maxHeapMb };
}

function reaInstall(): { script: string; version: string } {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('rea-agents/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return { script: join(dirname(pkgPath), 'scripts', 'rea.mjs'), version: pkg.version };
}

/** Runs REA, streaming stdout to a file and showing its stderr progress events. */
function runRea(script: string, opts: Options, outFile: string): Promise<void> {
  const args = [script, 'analyze-javascript-application', opts.target, '--format', 'json'];
  if (opts.maxHeapMb) args.push('--max-heap-mb', opts.maxHeapMb);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const sink = createWriteStream(outFile);
    child.stdout.pipe(sink);
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
    child.on('error', reject);
    child.on('close', (code) => {
      if (tty) process.stderr.write('\r\x1b[2K');
      sink.end(() => {
        if (code === 0) resolvePromise();
        else reject(new CliError(`REA exited with code ${code}.\n${otherStderr.join('\n')}`));
      });
    });
  });
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
  lines.push('', `Wrote ${outFile}`, 'Open it at /open on the REA Studio site (or `npm run dev` → http://localhost:3000/open).');
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rea = reaInstall();
  const work = await mkdtemp(join(tmpdir(), 'rea-studio-'));
  try {
    const raw = join(work, 'rea-output.json');
    process.stderr.write(`Analyzing ${opts.target} with rea-agents@${rea.version} (static analysis; the app is not run)\n`);
    const started = Date.now();
    await runRea(rea.script, opts, raw);
    const { project } = await adaptReaFile(raw, { reaVersion: rea.version, maxBytes: MAX_REA_OUTPUT_BYTES });
    await writeFile(opts.out, JSON.stringify(project));
    process.stdout.write(`${summarize(project, opts.out, (Date.now() - started) / 1000)}\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof CliError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exitCode = 1;
});
