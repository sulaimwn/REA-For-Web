import Link from 'next/link';
import { UploadForm } from '../../components/UploadForm';
import { SiteFooter, SiteHeader } from '../../components/SiteChrome';

export const dynamic = 'force-dynamic';

export default function UploadPage() {
  const uploadsAvailable = ['local', 'r2'].includes(process.env.PIPELINE_STORAGE ?? '');
  return (
    <>
      <SiteHeader uploadsAvailable={uploadsAvailable} />
      <main className="doc">
        <h1>Explore your app</h1>
        {uploadsAvailable ? (
          <>
            <p>Upload an Electron app, a Windows program, or an Android APK to see how it works.</p>
            <UploadForm />
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
