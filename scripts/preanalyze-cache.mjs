// Trusted analysis host: load the same private environment as the queue service.
import { configFromEnv, UploadControl } from '../packages/pipeline/dist/server.js';
import { preanalyzeFile, PreanalysisError } from '../packages/pipeline/dist/preanalyze.js';

const args = process.argv.slice(2);
const [sourcePath, flag, expectedSha256, ...extra] = args;
if (!sourcePath || (flag !== undefined && (flag !== '--sha256' || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? '') || extra.length))) {
  console.error('Usage: node --env-file=<worker.env> scripts/preanalyze-cache.mjs <app-file> [--sha256 <recorded-release-digest>]');
  process.exitCode = 1;
} else {
  let control;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let lastStage = '';
  try {
    control = new UploadControl(configFromEnv());
    console.log('Preparing popular-app analysis using the existing private upload queue.');
    const result = await preanalyzeFile(control, {
      sourcePath, ...(expectedSha256 ? { expectedSha256 } : {}), signal: controller.signal,
      onStatus: status => {
        const stage = status.progress?.phase ?? status.status;
        if (stage !== lastStage) { lastStage = stage; console.log(`Pre-analysis: ${status.status}.`); }
      },
    });
    console.log(`Private cache ready (${result.kind}; ${result.cacheHit ? 'existing verified result' : 'new sandbox result'}).`);
    console.log(`File SHA-256: ${result.sha256}`);
    console.log('Uploads of these exact bytes can now reuse this result after byte verification.');
  } catch (error) {
    // Environment, signed URLs, tokens, paths and provider errors stay private.
    console.error(controller.signal.aborted
      ? 'Stopped waiting. An already queued job continues with normal cleanup.'
      : error instanceof PreanalysisError ? error.message
      : 'Pre-analysis failed. Check the private worker/queue configuration.');
    process.exitCode = 1;
  } finally {
    // Interrupt only this tool's clients if graceful QUIT is stuck behind a
    // Redis outage. The separate worker/job remains under normal queue control.
    const closeDeadline = setTimeout(() => {
      control?.redis.disconnect();
      void control?.queue.disconnect().catch(() => {});
    }, 2000);
    try { await control?.close(); } catch { process.exitCode = 1; }
    finally { clearTimeout(closeDeadline); control?.redis.disconnect(); }
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
