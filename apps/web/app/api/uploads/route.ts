import {
  authorizeAdmission,
  uploadError,
  uploadJson,
  uploads,
} from '../../../lib/uploads-server';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const admission = await authorizeAdmission(request);
    return Response.json(await uploads().create(await uploadJson(request), admission.identity, admission.owner), {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return uploadError(error);
  }
}
