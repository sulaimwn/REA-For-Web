import {
  authorizeMutation,
  uploadError,
  uploadJson,
  uploads,
  uploadIdentity,
} from '../../../lib/uploads-server';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    authorizeMutation(request);
    return Response.json(await uploads().create(await uploadJson(request), uploadIdentity(request)), {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return uploadError(error);
  }
}
