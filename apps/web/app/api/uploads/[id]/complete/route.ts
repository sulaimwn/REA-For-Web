import {
  authorizeMutation,
  authorizeOrigin,
  jobToken,
  uploadError,
  uploads,
} from '../../../../../lib/uploads-server';
export const runtime = 'nodejs';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (uploads().config.publicUploads) authorizeOrigin(request);
    else authorizeMutation(request);
    const { id } = await params;
    return Response.json(await uploads().complete(id, jobToken(request)), {
      status: 202,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return uploadError(error);
  }
}
