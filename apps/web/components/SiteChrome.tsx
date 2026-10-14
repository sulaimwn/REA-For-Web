import Link from 'next/link';

export const REPO_URL = 'https://github.com/sulaimwn/REA-For-Web';
export const REA_REPO_URL = 'https://github.com/morluto/rea';

export function RepositoryLinks({ className = '' }: { className?: string }) {
  return (
    <nav aria-label="GitHub repositories" className={`repository-links ${className}`}>
      <a href={REPO_URL}>REA for Web on GitHub</a>
      <a href={REA_REPO_URL}>morluto/rea</a>
    </nav>
  );
}

export function SiteHeader({ uploadsAvailable = false, uploadHref = '/upload' }: { uploadsAvailable?: boolean; uploadHref?: string }) {
  return (
    <header className="site-head">
      <Link href="/" className="wordmark">
        REA for Web
      </Link>
      <nav aria-label="Site">
        <Link href="/#demos">Demos</Link>
        <Link href="/#reading">How to read the map</Link>
        <Link href="/open">Open your own app</Link>
        {uploadsAvailable && <Link href={uploadHref}>Upload an app</Link>}
      </nav>
      <RepositoryLinks className="site-head__end" />
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-foot">
      <span>
        Analysis by <a href={REA_REPO_URL}>REA (morluto/rea)</a> (MIT). Program files are never executed. Website capture loads the page in a fresh browser.
      </span>
      <a href={REPO_URL}>sulaimwn/REA-For-Web</a>
    </footer>
  );
}
