import Link from 'next/link';
import { UploadForm } from '../../components/UploadForm';
import { SiteFooter, SiteHeader } from '../../components/SiteChrome';
import { uploadLocation } from '../../lib/upload-location';

export const dynamic = 'force-dynamic';

export default function UploadPage() {
  const uploadsAvailable = ['local', 'r2'].includes(process.env.PIPELINE_STORAGE ?? '');
  const uploadHref = uploadLocation();
  return (
    <>
      <SiteHeader uploadsAvailable={Boolean(uploadHref)} uploadHref={uploadHref ?? '/upload'} />
      <main className="doc">
        <h1>Explore your app</h1>
        {uploadsAvailable ? (
          <>
            <p>Upload an Electron app, a Windows program, or an Android APK to see how it works.</p>
            <UploadForm />
          </>
        ) : uploadHref ? (
          <>
            <p>Upload your application on our analysis site. Its map opens there when analysis finishes.</p>
            <p><Link className="btn btn--primary" href={uploadHref}>Upload an app</Link></p>
          </>
        ) : (
          <p>
            Uploads aren’t available on this site yet. You can{' '}
            <Link href="/open">analyze your app locally and open its map</Link>.
          </p>
        )}
        <SiteFooter />
      </main>
    </>
  );
}
