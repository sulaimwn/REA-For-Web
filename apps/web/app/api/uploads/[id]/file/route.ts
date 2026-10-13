import { Readable } from 'node:stream';
import { LocalStore } from '@rea-studio/pipeline/server';
import {
  PipelineError,
  uploadError,
  uploads,
} from '../../../../../lib/uploads-server';
export const runtime = 'nodejs';
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const c = uploads();
    if (!(c.config.store instanceof LocalStore))
      throw new PipelineError(404, 'Local upload endpoint is disabled.');
    if (request.headers.get('Origin') !== c.config.origin)
      throw new PipelineError(403, 'Upload request origin is not allowed.');
    const { id } = await params,
      r = await c.record(id);
    if (await c.queue.getJob(id))
      throw new PipelineError(409, 'Upload is already queued.');
    if (!request.body) throw new PipelineError(400, 'Upload body is missing.');
    const url = new URL(request.url);
    await c.config.store.receive(
      id,
      r,
      Number(url.searchParams.get('expires')),
      url.searchParams.get('signature') ?? '',
      Readable.fromWeb(
        request.body as import('node:stream/web').ReadableStream,
      ),
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    return uploadError(error);
  }
}
