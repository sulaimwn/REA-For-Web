import { UploadJob } from '../../../components/UploadJob';
export default async function JobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <UploadJob key={id} id={id} />;
}
