import { runAnalysis } from "./run-analysis.js";
import { WorkerError } from "./limits.js";

const args = process.argv.slice(2);
const native = args.includes("--native");
const [targetPath, outputRoot, ...extra] = args.filter(a => a !== "--native");
if (!targetPath || !outputRoot || extra.length) {
  console.error("Usage: npm run analyze --workspace=@rea-studio/worker -- <target.asar|directory|program.exe|.dll> <output-root> [--native]");
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  runAnalysis({
    targetPath, outputRoot, native, signal: controller.signal,
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
