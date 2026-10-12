import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackage, getRawHeader } from "@electron/asar";
import { preflightTarget } from "../src/preflight.js";
import { DEFAULT_LIMITS, resolveLimits } from "../src/limits.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
async function archiveContext(t: TestContext) {
  const temp = await mkdtemp(join(repo, ".worker-test-"));
  t.after(async () => {
    assert.equal(dirname(temp), repo);
    await rm(temp, { recursive: true, force: true });
  });
  const path = join(temp, "tiny.asar");
  await createPackage(join(repo, "fixtures/sample-apps/tiny-electron"), path);
  return { temp, path };
}

async function alterHeader(path: string, mutation: (header: Record<string, any>) => void) {
  // Use Electron's parser for the ground truth. Preserve pickle framing and
  // payload offsets; pad shorter malicious headers with valid JSON whitespace.
  const { header, headerString } = getRawHeader(path);
  mutation(header);
  const next = Buffer.from(JSON.stringify(header));
  const capacity = Buffer.byteLength(headerString);
  assert.ok(next.length <= capacity);
  const bytes = await readFile(path);
  bytes.fill(0x20, 16, 16 + capacity);
  next.copy(bytes, 16);
  await writeFile(path, bytes);
}

function firstFile(root: Record<string, any>): Record<string, any> {
  const stack: Record<string, any>[] = [root];
  while (stack.length) {
    const entry = stack.pop()!;
    if (entry.files) stack.push(...Object.values(entry.files) as Record<string, any>[]);
    else return entry;
  }
  assert.fail("Expected a file in the real archive");
}

test("accepts an ASAR made by Electron's official packager, without extraction", async t => {
  const ctx = await archiveContext(t);
  const result = await preflightTarget(ctx.path, "asar", DEFAULT_LIMITS);
  assert.equal(result.files, 8);
  assert.ok(result.logicalBytes > 0);
  assert.ok(result.physicalBytes > result.logicalBytes);
  assert.deepEqual(await readdir(ctx.temp), ["tiny.asar"]);
});

test("ASAR file cap counts packed contents, including an archive inside a directory", async t => {
  const ctx = await archiveContext(t);
  const limits = resolveLimits({ maxFiles: 2 });
  await assert.rejects(preflightTarget(ctx.path, "asar", limits), { code: "input_limit_exceeded" });
  await assert.rejects(preflightTarget(ctx.temp, "directory", limits), { code: "input_limit_exceeded" });
});

const mutations: [string, (header: Record<string, any>) => void][] = [
  ["symlink", root => { root.files = { escape: { link: "../secret" } }; }],
  ["traversal name", root => { root.files["../escape"] = firstFile(root); delete root.files.src; }],
  ["external unpacked file", root => { firstFile(root).unpacked = true; delete firstFile(root).integrity; }],
  ["out-of-bounds offset", root => { const file = firstFile(root); file.offset = "9007199254740990"; delete file.integrity; }],
  ["nested archive", root => { root.files = { "inner.asar": firstFile(root) }; }],
];
for (const [name, mutate] of mutations) {
  test(`rejects ASAR ${name}`, async t => {
    const ctx = await archiveContext(t);
    await alterHeader(ctx.path, mutate);
    await assert.rejects(preflightTarget(ctx.path, "asar", DEFAULT_LIMITS), { code: "invalid_input" });
  });
}

test("rejects oversized header allocation and truncated archives before JSON parsing", async t => {
  const ctx = await archiveContext(t);
  const bytes = await readFile(ctx.path);
  bytes.writeUInt32LE(0xffffffff, 4);
  await writeFile(ctx.path, bytes);
  await assert.rejects(preflightTarget(ctx.path, "asar", DEFAULT_LIMITS), { code: "input_limit_exceeded" });
  await writeFile(ctx.path, Buffer.alloc(4));
  await assert.rejects(preflightTarget(ctx.path, "asar", DEFAULT_LIMITS), { code: "invalid_input" });
});

test("rejects excessive directory depth", async t => {
  const ctx = await archiveContext(t);
  let dir = join(ctx.temp, "deep");
  const root = dir;
  for (let i = 0; i < 66; i++) {
    await mkdir(dir, { recursive: true });
    dir = join(dir, "d");
  }
  await assert.rejects(preflightTarget(root, "directory", DEFAULT_LIMITS), { code: "input_limit_exceeded" });
});
