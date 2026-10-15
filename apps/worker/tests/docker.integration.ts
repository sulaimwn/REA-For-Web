// Opt-in: requires the built worker image and a Linux Docker engine. This test
// analyzes inert source only and verifies normalized StudioProject output.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackage } from "@electron/asar";
import { DEFAULT_LIMITS, runAnalysis, WorkerError, type AnalysisProgress } from "../src/index.js";
import { executeDocker } from "../src/command.js";
import { containerArgs } from "../src/run-analysis.js";
import { NATIVE_WORKER_IMAGE } from "../src/limits.js";
import type { StudioProject } from "@rea-studio/schema";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const sample = join(repo, "fixtures/sample-apps/tiny-electron");

async function workerContainers() {
  const result = await executeDocker(["ps", "-aq", "--filter", "label=rea-studio.worker=true"], {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim().split(/\s+/u).filter(Boolean).sort();
}

async function workspace(t: TestContext) {
  const temp = await mkdtemp(join(repo, ".worker-test-"));
  t.after(async () => {
    assert.equal(dirname(temp), repo);
    await rm(temp, { recursive: true, force: true });
  });
  return temp;
}

test("real Docker applies the requested container configuration", { timeout: 30_000 }, async t => {
  const name = `rea-studio-${randomUUID()}`;
  t.after(async () => {
    const cleanup = await executeDocker(["rm", "--force", name], { signal: AbortSignal.timeout(10_000) });
    assert.equal(cleanup.code, 0, cleanup.stderr);
  });
  const creation = await executeDocker(containerArgs(name, sample, "directory", DEFAULT_LIMITS), {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(creation.code, 0, creation.stderr);
  const inspection = await executeDocker(["inspect", "--format", "{{json .}}", name], {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(inspection.code, 0, inspection.stderr);
  // Docker metadata only; raw REA output is never parsed by this package.
  const container = JSON.parse(inspection.stdout);
  assert.equal(container.Config.User, "1000:1000");
  assert.equal(container.HostConfig.NetworkMode, "none");
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.equal(container.HostConfig.Memory, DEFAULT_LIMITS.memoryMb * 1024 * 1024);
  assert.equal(container.HostConfig.MemorySwap, container.HostConfig.Memory);
  assert.equal(container.HostConfig.NanoCpus, DEFAULT_LIMITS.cpus * 1_000_000_000);
  assert.equal(container.HostConfig.PidsLimit, 128);
  assert.equal(container.HostConfig.Init, true);
  assert.deepEqual(container.HostConfig.CapDrop, ["ALL"]);
  assert.ok(container.HostConfig.SecurityOpt.includes("no-new-privileges=true"));
  assert.equal(container.HostConfig.LogConfig.Type, "none");
  assert.match(container.HostConfig.Tmpfs["/tmp"], /noexec/u);
  const input = container.Mounts.filter((mount: { Type: string }) => mount.Type === "bind");
  assert.equal(input.length, 1);
  assert.equal(input[0].Destination, "/input/target");
  assert.equal(input[0].RW, false);
  assert.equal(container.HostConfig.Mounts[0].BindOptions.NonRecursive, true);
});

test("real Docker/REA directory and ASAR analysis", { timeout: 180_000 }, async t => {
  const before = await workerContainers();
  const temp = await workspace(t);
  const archive = join(temp, "tiny.asar");
  await createPackage(sample, archive);
  for (const targetPath of [sample, archive]) {
    const events: AnalysisProgress[] = [];
    const output = await runAnalysis({
      targetPath, outputRoot: join(temp, "results"), limits: { timeoutMs: 60_000 },
      onProgress: value => events.push(value),
    });
    const project: StudioProject = JSON.parse(await readFile(output.projectPath, "utf8"));
    assert.equal(project.schemaVersion, "0.1.0");
    assert.equal(project.id, output.projectId);
    assert.equal(project.target.name, "tiny-electron");
    assert.equal(project.nodes.filter(n => n.kind === "process").length, 3);
    assert.equal(project.nodes.filter(n => n.kind === "ipc-channel").length, 3);
    assert.ok(project.findings.every(f => f.status !== "confirmed-absent"));
    assert.equal(output.reaVersion, "6.5.0");
    assert.ok(events.length > 0);
  }
  assert.equal((await readdir(join(temp, "results"))).length, 2);
  assert.deepEqual(await workerContainers(), before);
});

test("real Docker keeps the original filename when REA has no package name", { timeout: 60_000 }, async t => {
  const before = await workerContainers();
  const temp = await workspace(t);
  const input = join(temp, "app");
  await mkdir(input);
  await writeFile(join(input, "renderer.js"), 'const { ipcRenderer } = require("electron"); ipcRenderer.send("example");');
  const result = await runAnalysis({
    targetPath: input, targetName: "original app.asar", outputRoot: join(temp, "results"),
    limits: { timeoutMs: 30_000 },
  });
  const project = JSON.parse(await readFile(result.projectPath, "utf8")) as StudioProject;
  assert.equal(project.target.name, "original app.asar");
  assert.deepEqual(await workerContainers(), before);
});

test("real REA source timeout publishes its retained partial Evidence and removes the container", { timeout: 60_000 }, async t => {
  const before = await workerContainers();
  const temp = await workspace(t);
  const result = await runAnalysis({
    targetPath: sample, outputRoot: join(temp, "results"),
    limits: { timeoutMs: 30_000, sourceTimeoutMs: 1 },
  });
  const project = JSON.parse(await readFile(result.projectPath, "utf8")) as StudioProject;
  assert.equal(project.analysis.coverage.status, "partial");
  assert.ok(project.nodes.some(node => node.kind === "analysis-gap"));
  assert.deepEqual(await workerContainers(), before);
});

test("real Docker rejects oversized input and malformed ASAR without publishing results", { timeout: 60_000 }, async t => {
  const before = await workerContainers();
  const temp = await workspace(t);
  const outputRoot = join(temp, "results");
  const archive = join(temp, "invalid.asar");
  await writeFile(archive, "invalid archive header");
  for (const [targetPath, maxFiles, code] of [
    [sample, 1, "input_limit_exceeded"],
    [archive, 5_000, "invalid_input"],
  ] as const) {
    await assert.rejects(runAnalysis({ targetPath, outputRoot, limits: { maxFiles, timeoutMs: 20_000 } }),
      (error: unknown) => error instanceof WorkerError && error.code === code);
  }
  assert.deepEqual(await readdir(outputRoot), []);
  assert.deepEqual(await workerContainers(), before);
});

test("real Docker cancellation on REA progress removes the container and partial output", { timeout: 90_000 }, async t => {
  const before = await workerContainers();
  const temp = await workspace(t);
  const outputRoot = join(temp, "results");
  const controller = new AbortController();
  let progressSeen = false;
  await assert.rejects(runAnalysis({
    targetPath: sample, outputRoot, signal: controller.signal, limits: { timeoutMs: 60_000 },
    onProgress: () => { progressSeen = true; controller.abort(); },
  }), (error: unknown) => error instanceof WorkerError && error.code === "cancelled");
  assert.ok(progressSeen);
  assert.deepEqual(await readdir(outputRoot), []);
  assert.deepEqual(await workerContainers(), before);
});

test("real Docker reads a .NET program in the standard image and refuses a native one with the reason", { timeout: 120_000 }, async t => {
  const before = await workerContainers();
  const temp = await workspace(t);
  const output = await runAnalysis({
    targetPath: join(repo, "fixtures/sample-apps/tiny-dotnet/TinyNotes.exe"), outputRoot: join(temp, "results"),
    limits: { timeoutMs: 60_000 },
  });
  const project = JSON.parse(await readFile(output.projectPath, "utf8")) as StudioProject;
  assert.equal(project.target.appKind, "dotnet");
  assert.equal(project.nodes.filter(n => n.kind === "native-import").length, 3);
  await assert.rejects(runAnalysis({
    targetPath: join(repo, "fixtures/sample-apps/tiny-native/tiny-notes.exe"), outputRoot: join(temp, "refused"),
    limits: { timeoutMs: 60_000 },
  }), (error: unknown) => error instanceof WorkerError && error.code === "invalid_input");
  assert.deepEqual(await readdir(join(temp, "refused")), []);
  assert.deepEqual(await workerContainers(), before);
});

test("real Docker maps a native program with Ghidra in the native image", { timeout: 600_000 }, async t => {
  const image = await executeDocker(["image", "inspect", NATIVE_WORKER_IMAGE], { signal: AbortSignal.timeout(10_000) });
  if (image.code !== 0) {
    assert.notEqual(process.env.REA_REQUIRE_NATIVE_TESTS, "1", "The native image is required for this test run.");
    return t.skip(`${NATIVE_WORKER_IMAGE} is not built (apps/worker/Dockerfile.native)`);
  }
  const before = await workerContainers();
  const temp = await workspace(t);
  const events: AnalysisProgress[] = [];
  const output = await runAnalysis({
    targetPath: join(repo, "fixtures/sample-apps/tiny-native/tiny-notes.exe"), outputRoot: join(temp, "results"),
    native: true, onProgress: e => events.push(e),
  });
  const project = JSON.parse(await readFile(output.projectPath, "utf8")) as StudioProject;
  assert.equal(project.target.appKind, "native");
  assert.equal(project.nodes.filter(n => n.kind === "native-function").length, 49);
  assert.deepEqual(project.nodes.filter(n => n.kind === "endpoint").map(n => n.label), ["https://api.example.com/notes"]);
  assert.ok(events.some(e => e.phase === "native"));
  assert.deepEqual(await workerContainers(), before);
});

test("real Docker maps a Linux ELF program with Ghidra in the native image, and refuses it in the standard one (T028)", { timeout: 300_000 }, async t => {
  const image = await executeDocker(["image", "inspect", NATIVE_WORKER_IMAGE], { signal: AbortSignal.timeout(10_000) });
  if (image.code !== 0) {
    assert.notEqual(process.env.REA_REQUIRE_NATIVE_TESTS, "1", "The native image is required for this test run.");
    return t.skip(`${NATIVE_WORKER_IMAGE} is not built (apps/worker/Dockerfile.native)`);
  }
  const before = await workerContainers();
  const temp = await workspace(t);
  const elf = join(temp, "tiny-notes.elf");
  await writeFile(elf, await readFile(join(repo, "fixtures/sample-apps/tiny-linux/tiny-notes")));
  const output = await runAnalysis({ targetPath: elf, targetName: "tiny-notes", outputRoot: join(temp, "results"), native: true });
  const project = JSON.parse(await readFile(output.projectPath, "utf8")) as StudioProject;
  assert.deepEqual([project.target.format, project.target.appKind, project.target.name], ["elf", "native", "tiny-notes"]);
  const fn = (name: string) => project.nodes.find(n => n.kind === "native-function" && n.label === name);
  assert.ok(fn("sync_notes") && fn("save_note") && fn("remember_last"));
  assert.deepEqual(project.nodes.filter(n => n.kind === "endpoint").map(n => n.label), ["https://api.example.com/notes"]);
  await assert.rejects(runAnalysis({ targetPath: elf, outputRoot: join(temp, "refused"), limits: { timeoutMs: 60_000 } }),
    (error: unknown) => error instanceof WorkerError && error.code === "invalid_input");
  assert.deepEqual(await readdir(join(temp, "refused")), []);
  assert.deepEqual(await workerContainers(), before);
});

test("real Docker maps an Android app with JADX in the native image, and refuses it in the standard one", { timeout: 300_000 }, async t => {
  const image = await executeDocker(["image", "inspect", NATIVE_WORKER_IMAGE], { signal: AbortSignal.timeout(10_000) });
  if (image.code !== 0) {
    assert.notEqual(process.env.REA_REQUIRE_NATIVE_TESTS, "1", "The native image is required for this test run.");
    return t.skip(`${NATIVE_WORKER_IMAGE} is not built (apps/worker/Dockerfile.native)`);
  }
  const before = await workerContainers();
  const temp = await workspace(t);
  const apk = join(repo, "fixtures/sample-apps/tiny-android/tiny-notes.apk");
  const output = await runAnalysis({ targetPath: apk, outputRoot: join(temp, "results"), native: true, limits: { maxFiles: 1 } });
  const project = JSON.parse(await readFile(output.projectPath, "utf8")) as StudioProject;
  assert.equal(project.target.appKind, "android");
  assert.equal(project.nodes.filter(n => n.kind === "android-component").length, 4);
  assert.deepEqual(project.nodes.filter(n => n.kind === "bridge-api").map(n => n.label), ["window.notesBridge"]);
  assert.equal(project.analysis.coverage.status, "partial");
  assert.equal(project.nodes.filter(n => n.kind === "managed-method" && (n.name === "<init>" || n.name === "<clinit>")).length, 5);
  // APK resources are not app files (T057); the byte cap still rejects oversized APKs before JADX.
  await assert.rejects(runAnalysis({ targetPath: apk, outputRoot: join(temp, "capped"), native: true,
    limits: { maxInputBytes: (await readFile(apk)).length - 1 } }),
    (error: unknown) => error instanceof WorkerError && error.code === "input_limit_exceeded");
  assert.deepEqual(await readdir(join(temp, "capped")), []);
  await assert.rejects(runAnalysis({ targetPath: apk, outputRoot: join(temp, "refused"), limits: { timeoutMs: 60_000 } }),
    (error: unknown) => error instanceof WorkerError && error.code === "invalid_input");
  assert.deepEqual(await readdir(join(temp, "refused")), []);
  assert.deepEqual(await workerContainers(), before);
});

test("real Docker cancellation stops the native provider and removes its container and output", { timeout: 120_000 }, async t => {
  const image = await executeDocker(["image", "inspect", NATIVE_WORKER_IMAGE], { signal: AbortSignal.timeout(10_000) });
  if (image.code !== 0) {
    assert.notEqual(process.env.REA_REQUIRE_NATIVE_TESTS, "1", "The native image is required for this test run.");
    return t.skip(`${NATIVE_WORKER_IMAGE} is not built`);
  }
  const before = await workerContainers();
  const temp = await workspace(t);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(runAnalysis({
      targetPath: join(repo, "fixtures/sample-apps/tiny-native/tiny-notes.exe"),
      outputRoot: join(temp, "cancelled"), native: true, signal: controller.signal,
      onProgress: (event) => {
        if (event.phase === "native" && !timer) timer = setTimeout(() => controller.abort(), 3000);
      },
    }), (error: unknown) => error instanceof WorkerError && error.code === "cancelled");
    assert.ok(timer, "native analysis started");
    assert.deepEqual(await readdir(join(temp, "cancelled")), []);
    assert.deepEqual(await workerContainers(), before);
  } finally { if (timer) clearTimeout(timer); }
});

test("real Docker output limit removes the container and partial output", { timeout: 90_000 }, async t => {
  const before = await workerContainers();
  const temp = await workspace(t);
  const outputRoot = join(temp, "results");
  await assert.rejects(runAnalysis({
    targetPath: sample, outputRoot, limits: { maxOutputBytes: 128, timeoutMs: 60_000 },
  }), (error: unknown) => error instanceof WorkerError && error.code === "output_limit_exceeded");
  assert.deepEqual(await readdir(outputRoot), []);
  assert.deepEqual(await workerContainers(), before);
});
