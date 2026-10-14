// Real Linux Docker process-death regression. Only public static fixtures; no target execution.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { containerArgs, assertEngine } from "../src/run-analysis.js";
import { executeDocker } from "../src/command.js";
import { DEFAULT_LIMITS, WORKER_IMAGE, NATIVE_WORKER_IMAGE } from "../src/limits.js";
import { OWNER_TIMEOUT_MS } from "../src/owner-heartbeat.js";

const repo = resolve(import.meta.dirname, "../../../..");
const label = "rea-studio.owner-check";
const standard = process.env.REA_OWNER_TEST_IMAGE ?? WORKER_IMAGE;
const native = process.env.REA_OWNER_TEST_NATIVE_IMAGE ?? NATIVE_WORKER_IMAGE;
assert.match(standard, /^rea-studio-worker:[a-zA-Z0-9_.-]+$/u);
assert.match(native, /^rea-studio-worker-native:[a-zA-Z0-9_.-]+$/u);
const docker = async (args: string[]) => {
  const r = await executeDocker(args, { signal: AbortSignal.timeout(10_000) });
  assert.equal(r.code, 0, r.stderr.slice(-600));
  return r.stdout;
};
async function setup(t: TestContext) {
  assertEngine(JSON.parse(await docker(["info", "--format", "{{json .}}"])))
  await docker(["image", "inspect", standard, native]);
  const root = await mkdtemp(join(repo, ".worker-owner-test-"));
  const id = `owner-${randomBytes(6).toString("hex")}`;
  const names = new Set<string>();
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    for (const name of names) {
      const found = await executeDocker(["inspect", name], { signal: AbortSignal.timeout(10_000) });
      if (found.code !== 0) { assert.match(found.stderr, /No such (?:object|container)/iu); continue; }
      const [info] = JSON.parse(found.stdout);
      assert.equal(info.Config.Labels[label], id, "Never remove another run's container.");
      await docker(["rm", "--force", name]);
    }
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([new Promise(resolve => child.once("close", resolve)), delay(1000)]);
      }
    }
    assert.equal(dirname(root), repo);
    assert.ok(root.startsWith(join(repo, ".worker-owner-test-")));
    await rm(root, { recursive: true, force: true });
  });
  return { root, id, names, children };
}
async function stopped(name: string, maxMs: number) {
  const start = Date.now();
  for (;;) {
    const [info] = JSON.parse(await docker(["inspect", name]));
    if (!info.State.Running) return { info, elapsedMs: Date.now() - start };
    assert.ok(Date.now() - start < maxMs, "Sandbox must stop without host cleanup or its whole-job deadline.");
    await delay(100);
  }
}

test("an analysis sandbox stops when its actual Node owner is killed", { timeout: 45_000 }, async t => {
  const ctx = await setup(t);
  const helper = fileURLToPath(new URL("./helpers/owner-parent.js", import.meta.url));
  const child = spawn(process.execPath, [helper, join(repo, "fixtures/sample-apps/tiny-native/tiny-notes.exe"), ctx.root, ctx.id, native], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  ctx.children.push(child);
  let analyzing = false, published = false, failed = false;
  child.on("message", (message: { type?: string; name?: string }) => {
    if (message.type === "container" && typeof message.name === "string") ctx.names.add(message.name);
    if (message.type === "analyzing") analyzing = true;
    if (message.type === "unexpected-result") published = true;
  });
  child.on("error", () => { failed = true; });
  child.stdout?.resume(); child.stderr?.resume();
  const start = Date.now();
  while (!analyzing) {
    assert.equal(failed, false);
    assert.equal(published, false);
    assert.equal(child.exitCode, null, "Fixture must reach native analysis before killing its owner.");
    assert.ok(Date.now() - start < 15_000);
    await delay(50);
  }
  assert.equal(ctx.names.size, 1);
  const name = [...ctx.names][0]!;
  const [before] = JSON.parse(await docker(["inspect", name]));
  assert.equal(before.State.Running, true);
  assert.equal(before.Config.User, "1000:1000");
  assert.equal(before.HostConfig.NetworkMode, "none");
  assert.equal(before.HostConfig.ReadonlyRootfs, true);
  child.kill("SIGKILL");
  const { info, elapsedMs } = await stopped(name, OWNER_TIMEOUT_MS + 5000);
  assert.equal(info.State.ExitCode, 130);
  assert.equal(info.State.Pid, 0);
  assert.equal(published, false);
  for (const entry of await readdir(ctx.root)) {
    if (entry.startsWith("rea-job-")) assert.ok(!(await readdir(join(ctx.root, entry))).includes("studio-project.json"));
  }
  t.diagnostic(`Killed owner: sandbox stopped after ${elapsedMs}ms with no published artifact.`);
});

test("a connected Docker client without an initial owner beat cannot start analysis", { timeout: 30_000 }, async t => {
  const ctx = await setup(t);
  const name = `rea-${ctx.id}`;ctx.names.add(name);
  const args = containerArgs(name, join(repo, "fixtures/sample-apps/tiny-electron.asar"), "asar", {
    ...DEFAULT_LIMITS, timeoutMs: 60_000, sourceTimeoutMs: 60_000,
  });
  args.splice(1, 0, "--label", `${label}=${ctx.id}`);
  args[args.indexOf(WORKER_IMAGE)] = standard;
  await docker(args);
  // Deliberately keep stdin open and silent. This models a stuck attach client,
  // so EOF cannot explain the shutdown; the image's 20s watchdog must enforce it.
  const child = spawn("docker", ["start", "--attach", "--interactive", name], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  ctx.children.push(child);
  child.stdin.on("error", () => {});
  let output = "", errors = "";
  child.stdout.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-1024); });
  child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4096); });
  child.on("error", () => {});
  // docker start is asynchronous; wait for the actual running state first.
  const start = Date.now();
  for (;;) {
    const [info] = JSON.parse(await docker(["inspect", name]));
    if (info.State.Running) break;
    assert.ok(Date.now() - start < 3000);
    await delay(50);
  }
  const { info, elapsedMs } = await stopped(name, OWNER_TIMEOUT_MS + 5000);
  assert.equal(info.State.ExitCode, 130);
  assert.equal(info.State.Pid, 0);
  assert.ok(elapsedMs >= OWNER_TIMEOUT_MS - 2000, "The owner timer, rather than EOF or a parse failure, must terminate it.");
  assert.equal(output, "");
  assert.match(errors, /Analysis owner disconnected/u);
  assert.doesNotMatch(errors, /studio_worker_result|Container deadline exceeded/u);
  t.diagnostic(`Silent connected client: owner watchdog stopped sandbox after ${elapsedMs}ms.`);
});
