import { timingSafeEqual } from 'node:crypto';
import {
  UploadControl,
  configFromEnv,
  PipelineError,
  networkIdentity,
  UPLOAD_BUSY_MESSAGE,
  verifyChallenge,
} from '@rea-studio/pipeline/server';
export { PipelineError };
let control: UploadControl | undefined;
export function uploads() {
  return (control ??= new UploadControl(configFromEnv()));
}
export function publicUploadSiteKey() {
  return process.env.PIPELINE_PUBLIC_UPLOADS === '1' ? configFromEnv().publicChallenge?.siteKey : undefined;
}
export function authorizeOrigin(request: Request) {
  const config = uploads().config;
  if (request.headers.get('Origin') !== config.origin)
    throw new PipelineError(403, 'Upload request origin is not allowed.');
}
function ownerKey(request: Request) {
    const actual = request.headers.get('X-REA-Access-Key') ?? '';
    const expected = process.env.PIPELINE_ACCESS_KEY ?? '';
    return expected.length >= 32 && !(
      Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    );
}
export function authorizeMutation(request: Request) {
  authorizeOrigin(request);
  const config = uploads().config;
  if ((config.store.kind === 'r2' || config.hostedLocal) && !ownerKey(request))
    throw new PipelineError(403, 'Enter the upload access key.');
}
export async function authorizeAdmission(request: Request) {
  authorizeOrigin(request);
  const config = uploads().config;
  if (config.publicUploads) {
    if (ownerKey(request)) return { owner: true, identity: undefined };
    if (request.headers.get('X-REA-Access-Key'))
      throw new PipelineError(403, 'The access key was not accepted. Clear it to upload without a key.');
    const identity = uploadIdentity(request);
    if (config.publicChallenge)
      await verifyChallenge(request.headers.get('X-REA-Turnstile-Token'), config.publicChallenge);
    return { owner: false, identity };
  }
  authorizeMutation(request);
  return { owner: false, identity: uploadIdentity(request) };
}
export function jobToken(request: Request) {
  return request.headers.get('Authorization')?.replace(/^Bearer /u, '') ?? '';
}
export function uploadIdentity(request: Request): string | undefined {
  const secret = uploads().config.visitorSecret;
  return secret ? networkIdentity(request.headers.get('X-REA-Client-IP'), secret) : undefined;
}
export async function uploadJson(request: Request) {
  if (!request.body)
    throw new PipelineError(400, 'Upload details are missing.');
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4096) {
      await reader.cancel();
      throw new PipelineError(413, 'Upload details are too large.');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new PipelineError(400, 'Upload details are invalid.');
  }
}
export function uploadError(error: unknown) {
  const status = error instanceof PipelineError ? error.status : 503;
  const message =
    error instanceof PipelineError && (status !== 503 || error.message === UPLOAD_BUSY_MESSAGE)
      ? error.message
      : 'Uploads are not available on this server yet.';
  return Response.json(
    { error: message },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}
