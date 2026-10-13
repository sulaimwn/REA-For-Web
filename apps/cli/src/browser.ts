// Headless Chrome for website analysis (T021): a throwaway profile and a debugging port on
// 127.0.0.1 only, so REA's analyze-web-bundle can capture the page's scripts. The page runs as in
// a normal visit; nothing about the user's own browser profile is used. Edge is deliberately not
// used: it signs fresh profiles into the Windows account.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES: Record<string, string[]> = {
  win32: [
    join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

export function findChrome(): string | null {
  const fromEnv = process.env['CHROME_PATH'];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return (CANDIDATES[process.platform] ?? []).find((p) => p !== '' && existsSync(p)) ?? null;
}

export interface Browser {
  /** Loopback DevTools HTTP endpoint, e.g. http://127.0.0.1:53211 */
  endpoint: string;
  /** DevTools id of the page showing the URL. */
  targetId: string;
  close(): Promise<void>;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens `url` in a headless Chrome and waits for the page to load and settle. */
export async function openPage(chrome: string, url: string, settleMs = 3000): Promise<Browser> {
  const profile = await mkdtemp(join(tmpdir(), 'rea-studio-chrome-'));
  const child: ChildProcess = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--disable-extensions', '--disable-background-networking', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, url,
  ], { stdio: 'ignore' });
  const close = async () => {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r(null) : child.once('exit', r)));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  try {
    // Chrome writes its chosen port to DevToolsActivePort in the profile.
    let port: string | undefined;
    for (let i = 0; i < 100 && !port; i++) {
      port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split(/\r?\n/u)[0] || undefined;
      if (!port) await pause(100);
    }
    if (!port || !/^\d+$/u.test(port)) throw new Error('Chrome did not open a debugging port.');
    const endpoint = `http://127.0.0.1:${port}`;
    let targetId: string | undefined;
    for (let i = 0; i < 150 && !targetId; i++) {
      const pages = (await fetch(`${endpoint}/json/list`).then((r) => r.json()).catch(() => [])) as { id: string; type: string; url: string }[];
      targetId = pages.find((p) => p.type === 'page' && /^https?:/u.test(p.url))?.id;
      if (!targetId) await pause(200);
    }
    if (!targetId) throw new Error(`Chrome didn't load ${url}.`);
    await pause(settleMs); // let the page load its scripts
    return { endpoint, targetId, close };
  } catch (error) {
    await close();
    throw error;
  }
}
