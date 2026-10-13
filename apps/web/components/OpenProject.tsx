'use client';

import type { StudioProject } from '@rea-studio/schema';
import { useState, type DragEvent } from 'react';
import { ProjectFileError, readProjectFile } from '../lib/open-project';
import { ProjectExplorer } from './Explorer';
import { ProjectBoundary } from './ProjectBoundary';
import { REPO_URL, SiteFooter, SiteHeader } from './SiteChrome';

export function OpenProject() {
  const [project, setProject] = useState<StudioProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  async function open(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setProject(await readProjectFile(file));
    } catch (e) {
      setError(e instanceof ProjectFileError ? e.message : `Couldn’t read this file (${e instanceof Error ? e.message : String(e)}).`);
    } finally {
      setBusy(false);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    void open(e.dataTransfer.files[0]);
  }

  if (project) {
    return (
      <ProjectBoundary onReset={() => setProject(null)}>
      <ProjectExplorer
        project={project}
        title={project.target.name}
        note="Opened from a file on this computer. Nothing was uploaded"
        actions={
          <button type="button" className="btn" onClick={() => setProject(null)}>
            Open another file
          </button>
        }
      />
      </ProjectBoundary>
    );
  }

  return (
    <>
    <SiteHeader />
    <main className="doc">
      <h1>Explore your own app, without uploading it.</h1>
      <p>
        Analyze the app on your machine, then open the result here. The file is read by your browser and never leaves
        your computer.
      </p>

      <ol className="steps">
        <li>
          <strong>Analyze</strong> an extracted Electron app folder, an <code>.asar</code>, or a .NET <code>.exe</code> /{' '}
          <code>.dll</code>, from a clone of the <a href={REPO_URL}>REA for Web repository</a> after <code>npm install</code>.
          REA only reads the files; it never runs the app.
          <pre className="code">npm run analyze -w rea-studio -- path/to/app.asar</pre>
          This writes <code>app.studio.json</code> (for <code>Program.exe</code>, <code>Program.studio.json</code>). See the{' '}
          <code>apps/cli</code> README for options.
        </li>
        <li>
          <strong>Open</strong> the <code>.studio.json</code> file:
        </li>
      </ol>

      <label
        className={`dropzone ${dragging ? 'dropzone--over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input type="file" accept=".json,application/json" onChange={(e) => void open(e.target.files?.[0])} />
        <span className="dropzone__title">{busy ? 'Reading…' : 'Drop a .studio.json file here'}</span>
        <span className="muted">or click to choose one</span>
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <SiteFooter />
    </main>
    </>
  );
}
