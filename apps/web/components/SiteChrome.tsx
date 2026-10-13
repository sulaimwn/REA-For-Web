import Link from 'next/link';

export const REPO_URL = 'https://github.com/sulaimwn/REA-For-Web';

export function SiteHeader() {
  return (
    <header className="site-head">
      <Link href="/" className="wordmark">
        REA Studio
      </Link>
      <nav aria-label="Site">
        <Link href="/#demos">Demos</Link>
        <Link href="/#reading">How to read the map</Link>
        <Link href="/open">Open your own app</Link>
      </nav>
      <a className="site-head__end" href={REPO_URL}>
        Source on GitHub
      </a>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-foot">
      <span>
        Analysis by <a href="https://github.com/morluto/rea">REA</a> (MIT). Static analysis only: no app is ever run.
      </span>
      <a href={REPO_URL}>REA Studio source</a>
    </footer>
  );
}
