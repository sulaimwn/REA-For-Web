import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { adaptReaFile } from "@rea-studio/rea-adapter/file";
import { runWithDocker, containerArgs, assertEngine } from "../src/run-analysis.js";
import { executeCommand, type CommandOptions } from "../src/command.js";
import { DEFAULT_LIMITS, NATIVE_WORKER_IMAGE, WORKER_IMAGE, nativeWorkerFromEnv, resolveLimits, queueLimitsFromEnv } from "../src/limits.js";
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
  assert.equal(result.reaVersion, "6.5.0");
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
  // T046: CPUs per job are an operator setting within the sandbox's existing 0.1–4 range; the default stays 1.
  assert.equal(defaults.cpus, 1);
  const twoCpus = queueLimitsFromEnv({ REA_ANALYSIS_CPUS: "2" });
  assert.equal(twoCpus.cpus, 2);
  assert.ok(containerArgs("job", sample, "directory", twoCpus).includes("--cpus=2"));
  assert.equal(queueLimitsFromEnv({ REA_ANALYSIS_CPUS: "1.5" }).cpus, 1.5);
  for (const bad of ["0", "5", "", "two", "-1", "Infinity"]) {
    assert.throws(() => queueLimitsFromEnv({ REA_ANALYSIS_CPUS: bad }), { code: "invalid_input" }, bad);
  }
  // T057: real apps need more room; the operator can grant it, only inside the reviewed ranges.
  assert.equal(defaults.maxFiles, 20_000);
  const roomy = queueLimitsFromEnv({
    REA_ANALYSIS_MEMORY_MB: "4096", REA_ANALYSIS_HEAP_MB: "3072",
    REA_ANALYSIS_MAX_INPUT_BYTES: String(1024 ** 3), REA_ANALYSIS_MAX_FILES: "20000",
  });
  assert.deepEqual([roomy.memoryMb, roomy.heapMb, roomy.maxInputBytes, roomy.maxFiles], [4096, 3072, 1024 ** 3, 20_000]);
  assert.ok(containerArgs("job", sample, "directory", roomy).includes("--memory=4096m"));
  for (const [name, bad] of [["REA_ANALYSIS_MEMORY_MB", "16384"], ["REA_ANALYSIS_MAX_FILES", "50000"],
    ["REA_ANALYSIS_MAX_INPUT_BYTES", String(2 * 1024 ** 3)], ["REA_ANALYSIS_HEAP_MB", "lots"]] as const) {
    assert.throws(() => queueLimitsFromEnv({ [name]: bad }), { code: "invalid_input" }, name);
  }
  // The heap must still leave the container room for everything else.
  assert.throws(() => queueLimitsFromEnv({ REA_ANALYSIS_MEMORY_MB: "2048", REA_ANALYSIS_HEAP_MB: "2048" }), { code: "invalid_input" });
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

test("an older worker image cannot silently ignore the owner channel or start an analysis", async t => {
  const ctx = await context(t, "old-image");
  await assert.rejects(runWithDocker(ctx.options, ctx.docker), { code: "docker_failed", message: /owner-liveness protocol/u });
  await assert.rejects(readFile(ctx.config.createArgs), { code: "ENOENT" });
  assert.deepEqual(await readdir(ctx.options.outputRoot), []);
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

test("programs (.exe/.dll) mount as one read-only file and pick the image from the operator setting", async t => {
  const ctx = await context(t);
  const exe = join(repo, "fixtures/sample-apps/tiny-native/tiny-notes.exe");
  const args = containerArgs("job", exe, "exe", DEFAULT_LIMITS, "tiny-notes.exe");
  assert.match(args[args.indexOf("--mount") + 1]!, /,target=\/input\/target\.exe,bind-recursive=disabled,readonly$/u);
  assert.ok(args.includes(WORKER_IMAGE) && args.includes("--pids-limit=128") && args.includes("--network=none"));
  const native = containerArgs("job", exe, "dll", DEFAULT_LIMITS, "x.dll", NATIVE_WORKER_IMAGE);
  assert.ok(native.includes(NATIVE_WORKER_IMAGE) && native.includes("--pids-limit=128"));
  assert.match(native[native.indexOf("--mount") + 1]!, /target=\/input\/target\.dll,/u);
  assert.throws(() => containerArgs("job", exe, "exe", DEFAULT_LIMITS, "x.exe", "attacker/image"), { code: "invalid_input" });
  for (const [nativeOption, image] of [[false, WORKER_IMAGE], [true, NATIVE_WORKER_IMAGE]] as const) {
    await runWithDocker({ targetPath: exe, outputRoot: join(ctx.temp, `results-${nativeOption}`), native: nativeOption }, ctx.docker);
    assert.ok(JSON.parse(await readFile(ctx.config.createArgs, "utf8")).includes(image));
  }
  // Directories and ASARs always use the standard image.
  await runWithDocker({ ...ctx.options, native: true }, ctx.docker);
  assert.ok(JSON.parse(await readFile(ctx.config.createArgs, "utf8")).includes(WORKER_IMAGE));
  const text = join(ctx.temp, "notes.txt");
  await writeFile(text, "MZ");
  await assert.rejects(runWithDocker({ targetPath: text, outputRoot: join(ctx.temp, "r") }, ctx.docker), { code: "invalid_input" });
});

test("program preflight checks the MZ header and the byte limit", async t => {
  const ctx = await context(t);
  const exe = join(repo, "fixtures/sample-apps/tiny-native/tiny-notes.exe");
  assert.equal((await preflightTarget(exe, "exe", DEFAULT_LIMITS)).files, 1);
  await assert.rejects(preflightTarget(exe, "exe", resolveLimits({ maxInputBytes: 1024 })), { code: "input_limit_exceeded" });
  const fake = join(ctx.temp, "fake.exe");
  await writeFile(fake, "#!/bin/sh\necho not a program\n");
  await assert.rejects(preflightTarget(fake, "exe", DEFAULT_LIMITS), { code: "invalid_input" });
  await assert.rejects(preflightTarget(sample, "exe", DEFAULT_LIMITS), { code: "invalid_input" });
  // An APK is a ZIP; a PE renamed to .apk (or the reverse) is refused before REA starts.
  const apk = join(repo, "fixtures/sample-apps/tiny-android/tiny-notes.apk");
  assert.ok((await preflightTarget(apk, "apk", DEFAULT_LIMITS)).entries > 1);
  await assert.rejects(preflightTarget(exe, "apk", DEFAULT_LIMITS), { code: "invalid_input" });
  await assert.rejects(preflightTarget(apk, "exe", DEFAULT_LIMITS), { code: "invalid_input" });
  const args = containerArgs("job", apk, "apk", DEFAULT_LIMITS, "tiny-notes.apk", NATIVE_WORKER_IMAGE);
  assert.match(args[args.indexOf("--mount") + 1]!, /target=\/input\/target\.apk,bind-recursive=disabled,readonly$/u);
  // A Linux ELF (T028) must carry its header; a PE or APK named .elf is refused before REA starts.
  const elf = join(repo, "fixtures/sample-apps/tiny-linux/tiny-notes");
  assert.equal((await preflightTarget(elf, "elf", DEFAULT_LIMITS)).files, 1);
  await assert.rejects(preflightTarget(exe, "elf", DEFAULT_LIMITS), { message: /no ELF header/u });
  await assert.rejects(preflightTarget(elf, "exe", DEFAULT_LIMITS), { code: "invalid_input" });
  const elfArgs = containerArgs("job", elf, "elf", DEFAULT_LIMITS, "tiny-notes", NATIVE_WORKER_IMAGE);
  assert.match(elfArgs[elfArgs.indexOf("--mount") + 1]!, /target=\/input\/target\.elf,bind-recursive=disabled,readonly$/u);
});

test("Linux programs are admitted as .elf or .so and run in the native image only when enabled", async t => {
  const ctx = await context(t);
  for (const name of ["tiny-notes.elf", "libtiny.so"]) {
    const copy = join(ctx.temp, name);
    await writeFile(copy, await readFile(join(repo, "fixtures/sample-apps/tiny-linux/tiny-notes")));
    for (const [native, image] of [[false, WORKER_IMAGE], [true, NATIVE_WORKER_IMAGE]] as const) {
      await runWithDocker({ targetPath: copy, outputRoot: join(ctx.temp, `results-${name}-${native}`), native }, ctx.docker);
      const args = JSON.parse(await readFile(ctx.config.createArgs, "utf8")) as string[];
      assert.ok(args.includes(image) && args.includes("elf"), `${name} ${image}`);
    }
  }
});

test("macOS programs: thin Mach-O headers only, admitted as .macho or .dylib, native image when enabled (T035)", async t => {
  const ctx = await context(t);
  // Headers only: preflight checks the signature and size before REA starts. The real jq macOS fixture is REA output.
  const header = (hex: string) => Buffer.concat([Buffer.from(hex, "hex"), Buffer.alloc(60)]);
  for (const [name, hex] of [["thin64.macho", "cffaedfe07000001"], ["thin32.macho", "cefaedfe07000000"], ["ppc.macho", "feedface00000012"]] as const) {
    const file = join(ctx.temp, name);
    await writeFile(file, header(hex));
    assert.equal((await preflightTarget(file, "macho", DEFAULT_LIMITS)).files, 1, name);
  }
  const universal = join(ctx.temp, "universal.macho");
  await writeFile(universal, header("cafebabe00000002"));
  await assert.rejects(preflightTarget(universal, "macho", DEFAULT_LIMITS), { message: /single-architecture macOS program/u });
  const elf = join(repo, "fixtures/sample-apps/tiny-linux/tiny-notes");
  await assert.rejects(preflightTarget(elf, "macho", DEFAULT_LIMITS), { code: "invalid_input" });
  await assert.rejects(preflightTarget(join(ctx.temp, "thin64.macho"), "elf", DEFAULT_LIMITS), { message: /no ELF header/u });
  for (const name of ["jq.macho", "libtiny.dylib"]) {
    const copy = join(ctx.temp, name);
    await writeFile(copy, header("cffaedfe07000001"));
    for (const [native, image] of [[false, WORKER_IMAGE], [true, NATIVE_WORKER_IMAGE]] as const) {
      await runWithDocker({ targetPath: copy, outputRoot: join(ctx.temp, `results-${name}-${native}`), native }, ctx.docker);
      const args = JSON.parse(await readFile(ctx.config.createArgs, "utf8")) as string[];
      assert.ok(args.includes(image) && args.includes("macho"), `${name} ${image}`);
      assert.match(args[args.indexOf("--mount") + 1]!, /target=\/input\/target\.macho,bind-recursive=disabled,readonly$/u);
    }
  }
});

test("the native image is an explicit operator setting", () => {
  assert.equal(nativeWorkerFromEnv({}), false);
  assert.equal(nativeWorkerFromEnv({ REA_NATIVE_WORKER: "0" }), false);
  assert.equal(nativeWorkerFromEnv({ REA_NATIVE_WORKER: "1" }), true);
  assert.throws(() => nativeWorkerFromEnv({ REA_NATIVE_WORKER: "yes" }), { code: "invalid_input" });
});

/** A stored (uncompressed) ZIP of empty entries, shaped like a real app's thousands of resources. */
function zipWithEntries(count: number): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const name = Buffer.from(`res/drawable/icon_${i}.png`);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    parts.push(local, name);
    centrals.push(central, name);
    offset += 30 + name.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

test("APK admission: thousands of resources are fine; expanded bytes and broken ZIP metadata are still refused (T057)", async t => {
  const ctx = await context(t);
  const apk = join(repo, "fixtures/sample-apps/tiny-android/tiny-notes.apk");
  // APK entries aren't app files: even a tight file cap no longer refuses an APK.
  assert.ok((await preflightTarget(apk, "apk", resolveLimits({ maxFiles: 1 }))).entries > 1);
  // WhatsApp-sized: more than the old 5,000-file cap, within the ZIP format's 65,534 entries.
  const many = join(ctx.temp, "many-resources.apk");
  await writeFile(many, zipWithEntries(6_000));
  assert.equal((await preflightTarget(many, "apk", DEFAULT_LIMITS)).entries, 6_000);
  const data = await readFile(apk);
  const central = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central > 0);
  const bomb = Buffer.from(data);
  bomb.writeUInt32LE(DEFAULT_LIMITS.maxInputBytes + 1, central + 24);
  const oversized = join(ctx.temp, "oversized.apk");
  await writeFile(oversized, bomb);
  await assert.rejects(preflightTarget(oversized, "apk", DEFAULT_LIMITS), { code: "input_limit_exceeded" });
  const broken = join(ctx.temp, "broken.apk");
  await writeFile(broken, data.subarray(0, data.length - 22));
  await assert.rejects(preflightTarget(broken, "apk", DEFAULT_LIMITS), { code: "invalid_input" });
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
