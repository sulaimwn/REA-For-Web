// Opt-in: requires the built worker image and a Linux Docker engine. This test
// analyzes inert source only, then verifies the resulting JSON at the adapter
// boundary once T004 exists. For now it checks opaque output/progress only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackage } from "@electron/asar";
import { runAnalysis, type AnalysisProgress } from "../src/index.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
test("real Docker/REA directory and ASAR analysis", { timeout: 180_000 }, async t => {
  const temp = await mkdtemp(join(repo, ".worker-test-"));
  t.after(async () => {
    assert.equal(dirname(temp), repo);
    await rm(temp, { recursive: true, force: true });
  });
  const sample = join(repo, "fixtures/sample-apps/tiny-electron");
  const archive = join(temp, "tiny.asar");
  await createPackage(sample, archive);
  for (const targetPath of [sample, archive]) {
    const events: AnalysisProgress[] = [];
    const output = await runAnalysis({
      targetPath, outputRoot: join(temp, "results"), limits: { timeoutMs: 60_000 },
      onProgress: value => events.push(value),
    });
    assert.ok((await readFile(output.rawResultPath)).length > 100);
    assert.equal(output.reaVersion, "6.4.0");
    assert.ok(events.length > 0);
  }
  assert.equal((await readdir(join(temp, "results"))).length, 2);
});
