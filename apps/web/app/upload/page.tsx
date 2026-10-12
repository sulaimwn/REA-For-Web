import Link from 'next/link';
import { UploadForm } from '../../components/UploadForm';
export default function UploadPage() {
  return (
    <main className="landing">
      <Link href="/">← REA Studio</Link>
      <h1>Explore your app</h1>
      <p>Upload an Electron .asar archive to build an evidence-backed map.</p>
      <UploadForm />
    </main>
  );
}
