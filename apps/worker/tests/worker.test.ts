import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { adaptReaFile } from "@rea-studio/rea-adapter/file";
import { runWithDocker, containerArgs, assertEngine } from "../src/run-analysis.js";
import { executeCommand, type CommandOptions } from "../src/command.js";
import { DEFAULT_LIMITS, resolveLimits, queueLimitsFromEnv } from "../src/limits.js";
import { preflightTarget } from "../src/preflight.js";
import { ProgressDecoder, type AnalysisProgress } from "../src/progress.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const fixture = join(repo, "fixtures/samples/tiny-electron.rea-6.4.0.json");
const sample = join(repo, "fixtures/sample-apps/tiny-electron");
const helper = fileURLToPath(new URL("./helpers/fake-docker.js", import.meta.url));

async function context(t: TestContext, mode = "success") {
  const temp = await mkdtemp(join(repo, ".worker-test-"));
  t.after(async () => {
    assert.equal(dirname(temp), repo);
    await rm(temp, { recursive: true, force: true });
  });
  const config = { mode, fixture, createArgs: join(temp, "create.json"), removed: join(temp, "removed.json") };
  const configPath = join(temp, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  return {
    temp, config,
    options: { targetPath: sample, outputRoot: join(temp, "results") },
    docker: (args: string[], options: CommandOptions) => executeCommand(process.execPath, [helper, configPath, ...args], options),
  };
}

test("streams the real adapter project unchanged and removes the container before publishing", async t => {
  const ctx = await context(t);
  const events: AnalysisProgress[] = [];
  const result = await runWithDocker({ ...ctx.options, onProgress: e => events.push(e) }, ctx.docker);
  const normalized = await adaptReaFile(fixture, { reaVersion: "6.4.0", maxBytes: DEFAULT_LIMITS.maxOutputBytes });
  const expected = Buffer.from(JSON.stringify(normalized.project));
  const actual = await readFile(result.projectPath);
  assert.equal(createHash("sha256").update(actual).digest("hex"), createHash("sha256").update(expected).digest("hex"));
  assert.equal(result.reaVersion, "6.4.0");
  assert.equal(result.projectId, normalized.project.id);
  assert.deepEqual(result.adapterReport, normalized.report);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.phase, "parse");
  assert.deepEqual(await readdir(dirname(result.projectPath)), ["studio-project.json"]);
  const args = JSON.parse(await readFile(ctx.config.createArgs, "utf8"));
  const removal = JSON.parse(await readFile(ctx.config.removed, "utf8"));
  assert.equal(args[args.indexOf("--name") + 1], removal[1]);
});

test("sandbox has no network, root privileges, writable input, or writable host mount", () => {
  const args = containerArgs("job", sample, "directory", DEFAULT_LIMITS);
  for (const flag of ["--network=none", "--user=1000:1000", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges=true", "--init", "--pids-limit=128", "--log-driver=none", "--pull=never",
    "--memory=2048m", "--memory-swap=2048m", "--cpus=1"]) assert.ok(args.includes(flag), flag);
  assert.equal(args.filter(a => a === "--mount").length, 1);
  assert.ok(args[args.indexOf("--mount") + 1]!.endsWith(",readonly"));
  assert.ok(args.some(a => a.startsWith("--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=")));
});

test("queue deadlines allow larger apps while rejecting unbounded operator settings", () => {
  const defaults = queueLimitsFromEnv({});
  assert.equal(defaults.timeoutMs, 900_000);
  assert.equal(defaults.sourceTimeoutMs, 180_000);
  const configured = queueLimitsFromEnv({ REA_ANALYSIS_TIMEOUT_MS: "1800000" });
  assert.equal(configured.timeoutMs, 1_800_000);
  assert.equal(configured.memoryMb, defaults.memoryMb);
  assert.equal(configured.cpus, defaults.cpus);
  assert.deepEqual(containerArgs("job", sample, "directory", configured).slice(-3, -1), ["1800000", "180000"]);
  assert.equal(queueLimitsFromEnv({ REA_SOURCE_TIMEOUT_MS: "1000" }).sourceTimeoutMs, 1000);
  assert.throws(() => queueLimitsFromEnv({ REA_SOURCE_TIMEOUT_MS: "900001" }), { code: "invalid_input" });
  assert.throws(() => queueLimitsFromEnv({ REA_SOURCE_TIMEOUT_MS: "0" }), { code: "invalid_input" });
  for (const value of ["", "0", "Infinity", "NaN", "900000.5", "1800001"]) {
    assert.throws(() => queueLimitsFromEnv({ REA_ANALYSIS_TIMEOUT_MS: value }), { code: "invalid_input" });
  }
});

test("original target names are passed as bounded arguments without paths", () => {
  assert.equal(containerArgs("job", sample, "directory", DEFAULT_LIMITS, "my app.asar").at(-1), "my app.asar");
  for (const targetName of ["", "a".repeat(201), "C:\\private\\app.asar", "../app.asar", "app\nasar"]) {
    assert.throws(() => containerArgs("job", sample, "directory", DEFAULT_LIMITS, targetName), { code: "invalid_input" });
  }
});

test("refuses an engine that cannot enforce resource limits", async t => {
  const ctx = await context(t, "unsafe-engine");
  await assert.rejects(runWithDocker(ctx.options, ctx.docker), { code: "unsafe_engine" });
  await assert.rejects(readFile(ctx.config.createArgs), { code: "ENOENT" });
  assert.deepEqual(await readdir(ctx.options.outputRoot), []);
  assert.throws(() => assertEngine({ OSType: "windows" }), { code: "unsafe_engine" });
});

for (const [mode, code] of [["failure", "analysis_failed"], ["oom", "out_of_memory"],
  ["container-timeout", "timeout"],
  ["empty", "analysis_failed"], ["no-receipt", "analysis_failed"], ["wrong-receipt", "analysis_failed"],
  ["limit-error", "input_limit_exceeded"], ["cleanup-failure", "cleanup_failed"]]) {
  test(`${mode} never publishes a result and performs container cleanup`, async t => {
    const ctx = await context(t, mode);
    await assert.rejects(runWithDocker(ctx.options, ctx.docker), { code });
    assert.ok(JSON.parse(await readFile(ctx.config.removed, "utf8")).includes("--force"));
    assert.deepEqual(await readdir(ctx.options.outputRoot), []);
  });
}

test("oversized stdout is stopped and discarded", async t => {
  const ctx = await context(t, "overflow");
  await assert.rejects(runWithDocker({ ...ctx.options, limits: { maxOutputBytes: 1024 } }, ctx.docker), { code: "output_limit_exceeded" });
  assert.ok(await readFile(ctx.config.removed));
  assert.deepEqual(await readdir(ctx.options.outputRoot), []);
});

test("job timeout kills the Docker client and explicitly removes its container", async t => {
  const ctx = await context(t, "hang");
  const start = Date.now();
  await assert.rejects(runWithDocker({ ...ctx.options, limits: { timeoutMs: 1000 } }, ctx.docker), { code: "timeout" });
  assert.ok(Date.now() - start < 10_000);
  assert.ok(await readFile(ctx.config.removed));
  assert.deepEqual(await readdir(ctx.options.outputRoot), []);
});

test("cancellation after progress removes the active container", async t => {
  const ctx = await context(t, "hang");
  const controller = new AbortController();
  await assert.rejects(runWithDocker({
    ...ctx.options, signal: controller.signal, onProgress: () => controller.abort(),
  }, ctx.docker), { code: "cancelled" });
  assert.ok(await readFile(ctx.config.removed));
});

test("already cancelled jobs do not contact Docker or create artifacts", async t => {
  const ctx = await context(t);
  await assert.rejects(runWithDocker({ ...ctx.options, signal: AbortSignal.abort() }, () => {
    assert.fail("Docker should not be invoked");
  }), { code: "cancelled" });
  await assert.rejects(readdir(ctx.options.outputRoot), { code: "ENOENT" });
});

test("a cancelled create with uncertain daemon state reports cleanup uncertainty", async t => {
  const ctx = await context(t, "create-hang");
  await assert.rejects(runWithDocker({ ...ctx.options, limits: { timeoutMs: 1000 } }, ctx.docker), { code: "cleanup_failed" });
  assert.ok(await readFile(ctx.config.removed));
  assert.deepEqual(await readdir(ctx.options.outputRoot), []);
});

test("progress callback failure still removes the container and discards stdout", async t => {
  const ctx = await context(t, "hang");
  await assert.rejects(runWithDocker({ ...ctx.options, onProgress: () => { throw new Error("Consumer failed"); } }, ctx.docker));
  assert.ok(await readFile(ctx.config.removed));
  assert.deepEqual(await readdir(ctx.options.outputRoot), []);
});

test("progress tolerates UTF-8 chunk boundaries, malformed lines, and huge stderr lines", () => {
  const events: AnalysisProgress[] = [];
  const decoder = new ProgressDecoder(e => events.push(e));
  const buffer = Buffer.from('{"rea_progress":{"phase":"parse","message":"café","terminal":true}}\n');
  const split = buffer.indexOf(Buffer.from("é")) + 1;
  decoder.write(buffer.subarray(0, split));
  decoder.write(buffer.subarray(split));
  decoder.write(Buffer.from("x".repeat(100_000) + "\nnot json\n"));
  decoder.write(Buffer.from('{"rea_progress":{"phase":"done","message":"ok"}}'));
  decoder.end();
  assert.deepEqual(events, [{ phase: "parse", message: "café", terminal: true }, { phase: "done", message: "ok" }]);
});

test("file and byte caps are enforced on the actual tiny Electron sample", async () => {
  const result = await preflightTarget(sample, "directory", DEFAULT_LIMITS);
  assert.ok(result.files > 1);
  await assert.rejects(preflightTarget(sample, "directory", resolveLimits({ maxFiles: 1 })), { code: "input_limit_exceeded" });
  await assert.rejects(preflightTarget(sample, "directory", resolveLimits({ maxInputBytes: 1 })), { code: "input_limit_exceeded" });
});

test("rejects output inside the input tree and paths that could alter mount parsing", async t => {
  const ctx = await context(t);
  const input = join(ctx.temp, "input");
  await mkdir(input);
  await assert.rejects(runWithDocker({ targetPath: input, outputRoot: join(input, "results") }, ctx.docker), { code: "invalid_input" });
  assert.deepEqual(await readdir(input), []);
  assert.throws(() => containerArgs("job", `${sample},target=/etc`, "directory", DEFAULT_LIMITS), { code: "invalid_input" });
  assert.throws(() => resolveLimits({ cpus: Infinity }), { code: "invalid_input" });
  assert.throws(() => resolveLimits({ memoryMb: 512, heapMb: 512 }), { code: "invalid_input" });
});

test("rejects a future output path through a junction into the input without writing there", async t => {
  const ctx = await context(t);
  const input = join(ctx.temp, "input");
  const alias = join(ctx.temp, "alias");
  await mkdir(input);
  await symlink(input, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(runWithDocker({ targetPath: input, outputRoot: join(alias, "nested", "results") }, ctx.docker), { code: "invalid_input" });
  assert.deepEqual(await readdir(input), []);
});

test("preflight rejects directory symlinks/junctions", async t => {
  const ctx = await context(t);
  const input = join(ctx.temp, "linked-input");
  const outside = join(ctx.temp, "outside");
  await mkdir(input);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "must not be followed");
  await symlink(outside, join(input, "escape"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(preflightTarget(input, "directory", DEFAULT_LIMITS), { code: "invalid_input" });
});
