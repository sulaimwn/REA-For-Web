import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { executeCommand } from "../src/command.js";
import { monitorOwner, OWNER_HEARTBEAT, OWNER_TIMEOUT_MS } from "../src/owner-heartbeat.js";

test("owner readiness requires input; fresh beats keep analysis alive until its owner disappears", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const input = new PassThrough();
  let lost = 0;
  const monitor = monitorOwner(input, () => { lost++; });
  t.after(() => monitor.close());
  let ready = false;
  void monitor.ready.then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  input.write(OWNER_HEARTBEAT);
  await monitor.ready;
  t.mock.timers.tick(OWNER_TIMEOUT_MS - 1);
  assert.equal(lost, 0);
  input.write(OWNER_HEARTBEAT);
  t.mock.timers.tick(OWNER_TIMEOUT_MS - 1);
  assert.equal(lost, 0);
  t.mock.timers.tick(1);
  assert.equal(lost, 1);
  t.mock.timers.tick(OWNER_TIMEOUT_MS);
  assert.equal(lost, 1);
});

test("a missing initial owner beat prevents readiness and terminates only once", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const input = new PassThrough();
  let lost = 0;
  const monitor = monitorOwner(input, () => { lost++; });
  t.after(() => monitor.close());
  const rejected = assert.rejects(monitor.ready, /owner disconnected/u);
  t.mock.timers.tick(OWNER_TIMEOUT_MS);
  await rejected;
  assert.equal(lost, 1);
  input.write(OWNER_HEARTBEAT);
  t.mock.timers.tick(OWNER_TIMEOUT_MS);
  assert.equal(lost, 1);
});

test("owner disconnect fails immediately; completed analysis removes its monitor", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const input = new PassThrough();
  let lost = 0;
  const monitor = monitorOwner(input, () => { lost++; });
  input.write(OWNER_HEARTBEAT);
  await monitor.ready;
  input.destroy();
  await new Promise<void>(resolve => process.nextTick(resolve));
  assert.equal(lost, 1);
  const finishedInput = new PassThrough();
  const finished = monitorOwner(finishedInput, () => { lost++; });
  finishedInput.write(OWNER_HEARTBEAT);
  await finished.ready;
  finished.close();
  t.mock.timers.tick(OWNER_TIMEOUT_MS * 2);
  await new Promise<void>(resolve => process.nextTick(resolve));
  assert.equal(lost, 1);
});

test("the real command pipe carries only the fixed owner heartbeat and closes normally", { timeout: 5000 }, async () => {
  const result = await executeCommand(process.execPath, ["-e",
    "process.stdin.once('data', b => process.stdout.write(b, () => process.exit(0)))"], {
    signal: AbortSignal.timeout(3000), ownerHeartbeat: true,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, OWNER_HEARTBEAT);
  assert.equal(result.stderr, "");
});
