import { Readable } from 'node:stream';
import {
  jobToken,
  uploadError,
  uploads,
} from '../../../../../lib/uploads-server';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params,
      stream = await uploads().project(id, jobToken(request));
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return uploadError(error);
  }
}
