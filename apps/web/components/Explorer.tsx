'use client';

import type { StudioProject } from '@rea-studio/schema';
import '@xyflow/react/dist/style.css';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Focus } from '../lib/graph-view';
import { indexProject, type DemoEntry } from '../lib/project';
import { GraphPane } from './GraphPane';
import { Inspector } from './Inspector';
import { Sidebar } from './Sidebar';

/** Loads a pre-built demo project by slug, then shows it. */
export function Explorer({ demo }: { demo: DemoEntry }) {
  const [project, setProject] = useState<StudioProject | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/projects/${demo.slug}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<StudioProject>;
      })
      .then((p) => live && setProject(p))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [demo.slug]);

  if (error) return <main className="center">Couldn’t load this project ({error}).</main>;
  if (!project) return <main className="center">Loading {demo.title}…</main>;
  return <ProjectExplorer project={project} title={demo.title} note={demo.sample} />;
}

interface ProjectExplorerProps {
  project: StudioProject;
  title: string;
  /** Extra context shown in the banner, e.g. that a demo fixture is trimmed. */
  note?: string | null;
  /** Extra controls for the top bar, e.g. "Open another file". */
  actions?: ReactNode;
}

/** The three-pane explorer for an already-loaded StudioProject. */
export function ProjectExplorer({ project, title, note = null, actions }: ProjectExplorerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>({ mode: 'overview' });
  const ix = useMemo(() => indexProject(project), [project]);

  // Shareable links: ?node=<selected id>&focus=<neighborhood id> restore the view.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (restored) return;
    const params = new URLSearchParams(window.location.search);
    const node = params.get('node');
    const focusId = params.get('focus');
    if (node && ix.byId.has(node)) setSelectedId(node);
    if (focusId && ix.byId.has(focusId)) setFocus({ mode: 'node', id: focusId });
    setRestored(true);
  }, [ix, restored]);
  useEffect(() => {
    if (!restored) return;
    const params = new URLSearchParams();
    if (selectedId) params.set('node', selectedId);
    if (focus.mode === 'node') params.set('focus', focus.id);
    const query = params.toString();
    window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
  }, [restored, selectedId, focus]);
  const select = useCallback((id: string) => setSelectedId(id), []);
  const selectAndFocus = useCallback((id: string) => {
    setSelectedId(id);
    setFocus({ mode: 'node', id });
  }, []);

  const a = project.analysis;
  const gaps = ix.byKind.get('analysis-gap')?.length ?? 0;
  return (
    <div className="explorer">
      <header className="topbar">
        <Link href="/" className="topbar__brand">
          REA Studio
        </Link>
        <div className="topbar__app">
          <strong>{title}</strong>
          {project.target.version && <span className="muted"> v{project.target.version}</span>}
          <span className="badge badge--conf">{project.target.appKind}</span>
          <span className={`badge ${a.coverage.status === 'complete' ? 'badge--ok' : 'badge--warn'}`}>{a.coverage.status} coverage</span>
        </div>
        {actions}
        <div className="topbar__meta muted">
          analyzed with {a.engine.package}@{a.engine.version} · {project.nodes.length.toLocaleString()} nodes · {project.edges.length.toLocaleString()} links
        </div>
      </header>

      {(a.coverage.status !== 'complete' || note) && (
        <div className="banner" role="note">
          {a.coverage.status !== 'complete' && (
            <span>
              <strong>Partial analysis.</strong> REA couldn’t fully analyze this app
              {a.filesWithAnalysisIssues > 0 && <> ({a.filesWithAnalysisIssues} files lost relationship details{gaps > 0 && `, ${gaps} gaps`})</>}. Anything
              marked “not found” may still exist.
            </span>
          )}
          {note && <span className="muted"> {note}.</span>}
        </div>
      )}

      <div className="panes">
        <Sidebar ix={ix} selectedId={selectedId} onSelect={selectAndFocus} />
        <GraphPane ix={ix} focus={focus} selectedId={selectedId} onSelect={select} onFocus={setFocus} />
        <Inspector ix={ix} node={selectedId ? ix.byId.get(selectedId) ?? null : null} onSelect={selectAndFocus} onFocus={setFocus} />
      </div>
    </div>
  );
}
