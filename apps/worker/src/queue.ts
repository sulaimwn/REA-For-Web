import { configFromEnv } from '@rea-studio/pipeline/server';
import {
  startAnalysisWorker,
  expireStaging,
} from '@rea-studio/pipeline/processor';
import { runAnalysis } from './run-analysis.js';
import { nativeWorkerFromEnv, queueLimitsFromEnv } from './limits.js';

const limits = queueLimitsFromEnv();
const native = nativeWorkerFromEnv();
const config = configFromEnv();
const worker = startAnalysisWorker(config, (options) =>
  runAnalysis({ ...options, native, limits }),
);
worker.on('error', () =>
  process.stderr.write('Upload queue connection failed.\n'),
);
worker.on('completed', () => process.stdout.write('Analysis job completed.\n'));
worker.on('failed', () => process.stderr.write('Analysis job failed.\n'));
await worker.waitUntilReady();
process.stdout.write('Upload analysis worker ready.\n');
// Also configure an R2 uploads/ lifecycle rule. This sweep covers local data
// and retries failed deletions while this host is running.
const sweep = () =>
  Promise.all([
    config.store.expireUploads(),
    expireStaging(config.workRoot),
  ]).catch(() => process.stderr.write('Upload expiry cleanup failed.\n'));
await sweep();
const timer = setInterval(() => void sweep(), 60 * 60 * 1000);
timer.unref();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await worker.close();
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
