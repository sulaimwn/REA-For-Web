import { jobToken, uploadError, uploads } from '../../../../lib/uploads-server';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return Response.json(await uploads().status(id, jobToken(request)), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return uploadError(error);
  }
}
