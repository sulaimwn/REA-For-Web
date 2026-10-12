'use client';

import type { StudioProject } from '@rea-studio/schema';
import '@xyflow/react/dist/style.css';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Focus } from '../lib/graph-view';
import { indexProject, type DemoEntry } from '../lib/project';
import { GraphPane } from './GraphPane';
import { Inspector } from './Inspector';
import { Sidebar } from './Sidebar';

export function Explorer({ demo }: { demo: DemoEntry }) {
  const [project, setProject] = useState<StudioProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>({ mode: 'overview' });

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

  const ix = useMemo(() => (project ? indexProject(project) : null), [project]);
  const select = useCallback((id: string) => setSelectedId(id), []);
  const selectAndFocus = useCallback((id: string) => {
    setSelectedId(id);
    setFocus({ mode: 'node', id });
  }, []);

  if (error) return <main className="center">Couldn’t load this project ({error}).</main>;
  if (!ix || !project) return <main className="center">Loading {demo.title}…</main>;

  const a = project.analysis;
  const gaps = ix.byKind.get('analysis-gap')?.length ?? 0;
  return (
    <div className="explorer">
      <header className="topbar">
        <Link href="/" className="topbar__brand">
          REA Studio
        </Link>
        <div className="topbar__app">
          <strong>{demo.title}</strong>
          {project.target.version && <span className="muted"> v{project.target.version}</span>}
          <span className="badge badge--conf">{project.target.appKind}</span>
          <span className={`badge ${a.coverage.status === 'complete' ? 'badge--ok' : 'badge--warn'}`}>{a.coverage.status} coverage</span>
        </div>
        <div className="topbar__meta muted">
          analyzed with {a.engine.package}@{a.engine.version} · {project.nodes.length.toLocaleString()} nodes · {project.edges.length.toLocaleString()} links
        </div>
      </header>

      {(a.coverage.status !== 'complete' || demo.sample) && (
        <div className="banner" role="note">
          {a.coverage.status !== 'complete' && (
            <span>
              <strong>Partial analysis.</strong> REA couldn’t fully analyze this app
              {a.filesWithAnalysisIssues > 0 && <> ({a.filesWithAnalysisIssues} files lost relationship details{gaps > 0 && `, ${gaps} gaps`})</>}. Anything
              marked “not found” may still exist.
            </span>
          )}
          {demo.sample && <span className="muted"> {demo.sample}.</span>}
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
