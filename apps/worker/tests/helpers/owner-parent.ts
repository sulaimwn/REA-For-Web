// Disposable test parent: production runner, fixed private images selected by the test.
import { runWithDocker } from "../../src/run-analysis.js";
import { executeDocker } from "../../src/command.js";
import { WORKER_IMAGE, NATIVE_WORKER_IMAGE } from "../../src/limits.js";

const [targetPath, outputRoot, id, image] = process.argv.slice(2);
if (!targetPath || !outputRoot || !/^owner-[a-f0-9]{12}$/u.test(id ?? "") ||
    !/^rea-studio-worker-native:[a-zA-Z0-9_.-]+$/u.test(image ?? "")) throw new Error("Invalid owner-test fixture settings.");
const result = await runWithDocker({
  targetPath, outputRoot, native: true, limits: { timeoutMs: 60_000 },
  onProgress: progress => {
    if (progress.phase === "native") process.send?.({ type: "analyzing" });
  },
}, async (original, options) => {
  const args = original.map(arg => arg === NATIVE_WORKER_IMAGE ? image! : arg);
  if (args[0] === "create") {
    const name = args[args.indexOf("--name") + 1];
    process.send?.({ type: "container", name });
    args.splice(1, 0, "--label", `rea-studio.owner-check=${id}`);
  }
  return executeDocker(args, options);
});
process.send?.({ type: "unexpected-result", projectId: result.projectId });
process.disconnect?.();
