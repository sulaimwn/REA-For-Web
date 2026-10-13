import Link from 'next/link';
import { KindGlyph } from '../components/KindGlyph';
import { LandingDemo } from '../components/LandingDemo';
import { SiteFooter, SiteHeader } from '../components/SiteChrome';
import { loadDemos } from '../lib/demos';

/** The demo shown first: small enough that its overview is readable at a glance. */
const FIRST = 'tiny-electron';

export default function HomePage() {
  const demos = loadDemos().sort((a, b) => Number(b.slug === FIRST) - Number(a.slug === FIRST));
  return (
    <>
      <SiteHeader />
      <main className="frontpage">
        <section className="intro">
          <div>
            <h1>See how an Electron app is put together.</h1>
            <p>
              REA for Web reads an app’s shipped files and maps its processes, windows, preload bridges, IPC channels, native
              add-ons and local storage. Each part comes with REA’s evidence, usually down to the file and line. Nothing is
              executed.
            </p>
          </div>
          <dl className="spec">
            <div>
              <dt>Reads</dt>
              <dd>
                An unpacked Electron app, or its <code>.asar</code> archive
              </dd>
            </div>
            <div>
              <dt>Shows</dt>
              <dd>A graph of the app, with the evidence behind every part</dd>
            </div>
            <div>
              <dt>Ask</dt>
              <dd>Questions in plain English, using your own Anthropic API key</dd>
            </div>
            <div>
              <dt>Engine</dt>
              <dd>
                <a href="https://github.com/morluto/rea">REA</a> 6.4.0, static analysis
              </dd>
            </div>
          </dl>
        </section>

        {demos.length > 0 ? (
          <LandingDemo demos={demos} />
        ) : (
          <p className="empty">
            No demo data yet. Run <code>npm run demo-data --workspace=@rea-studio/web</code>.
          </p>
        )}

        <section className="section" id="reading">
          <h2>How to read the map</h2>
          <p>Static analysis finds a lot and misses some. The drawing always shows how REA knows what it shows.</p>
          <div className="cols">
            <table className="key">
              <thead>
                <tr>
                  <th colSpan={2}>Links</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><span className="line" /></td>
                  <td><strong>Observed.</strong> REA saw this relationship directly in the code.</td>
                </tr>
                <tr>
                  <td><span className="line line--inferred" /></td>
                  <td><strong>Inferred.</strong> REA reasoned it from indirect evidence.</td>
                </tr>
                <tr>
                  <td><span className="line line--ipc" /></td>
                  <td><strong>IPC.</strong> A message that crosses from one process to another.</td>
                </tr>
                <tr>
                  <td><span className="line line--heuristic" /></td>
                  <td><strong>Studio heuristic.</strong> REA for Web’s own guess on top of REA’s findings. Always labeled as such.</td>
                </tr>
              </tbody>
            </table>
            <table className="key">
              <thead>
                <tr>
                  <th colSpan={2}>Parts</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><KindGlyph family="runtime" /></td>
                  <td><strong>Runtime.</strong> Processes, windows and workers.</td>
                </tr>
                <tr>
                  <td><KindGlyph family="boundary" /></td>
                  <td><strong>Boundaries.</strong> Preload bridges and IPC: where web content reaches into the app.</td>
                </tr>
                <tr>
                  <td><KindGlyph family="system" /></td>
                  <td><strong>System access.</strong> Native add-ons, local storage, network endpoint candidates.</td>
                </tr>
                <tr>
                  <td><KindGlyph family="code" /></td>
                  <td><strong>Code.</strong> Shipped files, modules and source files recovered from source maps.</td>
                </tr>
                <tr>
                  <td><KindGlyph family="gap" /></td>
                  <td><strong>Analysis gap.</strong> A file REA couldn’t fully read. “Not found” never means “doesn’t exist.”</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="section" id="demos">
          <h2>Demos</h2>
          <p>Real REA output from open-source apps, and a small sample app with a known answer key.</p>
          <table className="table">
            <thead>
              <tr>
                <th>App</th>
                <th className="num">Parts</th>
                <th className="num">Links</th>
                <th>Analysis</th>
                <th className="hide-narrow">Notes</th>
              </tr>
            </thead>
            <tbody>
              {demos.map((d) => (
                <tr key={d.slug}>
                  <td className="table__name">
                    <Link href={`/explore/${d.slug}`}>{d.title}</Link> {d.version && <span className="topbar__version">{d.version}</span>}
                    <span className="table__note">{d.blurb}</span>
                  </td>
                  <td className="num">{d.nodes.toLocaleString()}</td>
                  <td className="num">{d.edges.toLocaleString()}</td>
                  <td>
                    <span className={`status ${d.coverage === 'complete' ? 'status--complete' : 'status--partial'}`}>{d.coverage === 'complete' ? 'Complete' : 'Partial'}</span>
                  </td>
                  <td className="hide-narrow table__note">{d.sample}</td>
                </tr>
              ))}
              <tr>
                <td className="table__name" colSpan={5}>
                  <Link href="/open">Your own app</Link>
                  <span className="table__note">Analyze it on your computer with one command, then open the result here. Nothing is uploaded.</span>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <SiteFooter />
      </main>
    </>
  );
}
