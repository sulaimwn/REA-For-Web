import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Enforce the raw output cap while writing, before disk space is consumed. */
export async function pipeBoundedOutput(source: Readable, destination: Writable, maxBytes: number): Promise<void> {
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) callback(new Error(`REA output exceeded the ${maxBytes.toLocaleString()} byte limit.`));
      else callback(null, chunk);
    },
  });
  await pipeline(source, limit, destination);
}
