import { runAnalysis } from "./run-analysis.js";
import { WorkerError } from "./limits.js";

const [targetPath, outputRoot, ...extra] = process.argv.slice(2);
if (!targetPath || !outputRoot || extra.length) {
  console.error("Usage: npm run analyze --workspace=@rea-studio/worker -- <target.asar|directory> <output-root>");
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  runAnalysis({
    targetPath, outputRoot, signal: controller.signal,
    onProgress: progress => process.stderr.write(`${JSON.stringify({ progress })}\n`),
  }).then(result => console.log(JSON.stringify(result))).catch((error: unknown) => {
    console.error(JSON.stringify({
      error: error instanceof WorkerError ? error.code : "worker_failed",
      message: error instanceof Error ? error.message : "Worker failed.",
    }));
    process.exitCode = 1;
  }).finally(() => {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  });
}
