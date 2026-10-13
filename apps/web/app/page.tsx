import Link from 'next/link';
import { loadDemos } from '../lib/demos';

export default function HomePage() {
  const demos = loadDemos();
  return (
    <main className="home">
      <section className="hero">
        <p className="hero__eyebrow">REA Studio · v0.1 preview</p>
        <h1>See how an Electron app is put together.</h1>
        <p className="hero__lede">
          Processes, IPC channels, preload bridges, native add-ons, storage, and the original source tree recovered
          from source maps, with the evidence behind every fact. Powered by{' '}
          <a href="https://github.com/morluto/rea">REA</a> static analysis. Nothing is executed.
        </p>
      </section>

      <p><Link href="/upload" className="chip">Upload your own app →</Link></p>

      <section className="demos" aria-label="Demo apps">
        {demos.length === 0 && <p className="empty">No demo data yet. Run <code>npm run demo-data --workspace=@rea-studio/web</code>.</p>}
        {demos.map((d) => (
          <Link key={d.slug} href={`/explore/${d.slug}`} className="demo-card">
            <div className="demo-card__head">
              <strong>{d.title}</strong>
              {d.version && <span className="muted"> v{d.version}</span>}
              <span className={`badge ${d.coverage === 'complete' ? 'badge--ok' : 'badge--warn'}`}>{d.coverage} coverage</span>
            </div>
            <p>{d.blurb}</p>
            <p className="muted">
              {d.nodes.toLocaleString()} nodes · {d.edges.toLocaleString()} links
              {d.sample && <> · {d.sample}</>}
            </p>
            <span className="demo-card__cta">Explore →</span>
          </Link>
        ))}
        <Link href="/open" className="demo-card demo-card--local">
          <div className="demo-card__head">
            <strong>Your own app</strong>
            <span className="badge badge--ok">local mode</span>
          </div>
          <p>Analyze an Electron app on your machine, then open the result here. Nothing is uploaded.</p>
          <span className="demo-card__cta">Open a project file →</span>
        </Link>
      </section>

      <section className="honesty">
        <h2>What it can and can’t tell you</h2>
        <ul>
          <li>Every node shows REA’s evidence: file and line, whether it was observed or inferred, and REA’s confidence category.</li>
          <li>“Not found” never means “doesn’t exist.” Static analysis can miss things, especially in minified bundles.</li>
          <li>Explore your own app in local mode, or upload an .asar archive when the upload service is configured.</li>
        </ul>
      </section>
    </main>
  );
}
