'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { StudioProject } from '@rea-studio/schema';
import type { JobStatus } from '@rea-studio/pipeline/contracts';
import { ProjectExplorer } from './Explorer';
import { projectForUpload } from '../lib/upload-project';
import { SiteFooter, SiteHeader } from './SiteChrome';

export function UploadJob({ id }: { id: string }) {
  const [status, setStatus] = useState<JobStatus | null>(null),
    [project, setProject] = useState<StudioProject | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const token = sessionStorage.getItem(`rea-job:${id}`);
    if (!token) {
      setError(
        'This result is private to the browser session that uploaded it.',
      );
      return;
    }
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const headers = { Authorization: `Bearer ${token}` };
        const response = await fetch(`/api/jobs/${id}`, {
          headers,
          signal: abort.signal,
          cache: 'no-store',
        });
        const payload = await response.json();
        if (!response.ok)
          throw new Error(payload.error ?? 'Could not read analysis status.');
        const state = payload as JobStatus;
        setStatus(state);
        if (state.status === 'failed') return;
        if (state.status === 'succeeded') {
          const result = await fetch(`/api/jobs/${id}/project`, {
            headers,
            signal: abort.signal,
            cache: 'no-store',
          });
          if (!result.ok)
            throw new Error('Could not load the analysis result.');
          setProject(projectForUpload((await result.json()) as StudioProject, state.uploadName));
          return;
        }
        timer = setTimeout(() => void poll(), 1000);
      } catch (e) {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : 'Analysis is unavailable.');
      }
    }
    void poll();
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [id]);
  if (project)
    return (
      <ProjectExplorer
        key={id}
        project={project}
        title={project.target.name}
      />
    );
  const failed = status?.status === 'failed';
  return (
    <>
    <SiteHeader uploadsAvailable />
    <main className="doc">
      <Link href="/upload">← Upload an app</Link>
      <h1>
        {status?.errorCode === 'timeout'
          ? 'Analysis timed out'
          : error || failed
            ? 'Analysis unavailable'
            : 'Analyzing your app'}
      </h1>
      {!failed && !error && (
        <ol className="analysis-stages" aria-label="Analysis stages">
          <li>Upload received</li>
          <li aria-current={status?.status === 'queued' ? 'step' : undefined}>
            {status?.status === 'running' || status?.status === 'succeeded' ? 'Worker started' : 'Waiting for a worker'}
          </li>
          <li aria-current={status?.status === 'running' ? 'step' : undefined}>Analyze the app and build its map</li>
        </ol>
      )}
      <p role="status" aria-live="polite">
        {error ??
          status?.error ??
          status?.progress?.message ??
          (status?.status === 'queued'
            ? 'Waiting for the analysis worker…'
            : 'Checking analysis status…')}
      </p>
      {failed ? (
        <>
          {status.progress && (
            <p className="muted">Last step: {status.progress.message}</p>
          )}
          <Link className="btn" href="/upload">
            Upload this app again
          </Link>
        </>
      ) : !error ? (
        <p className="muted">
          Large apps may take several minutes. You can reload this page while
          analysis runs.
        </p>
      ) : null}
      <SiteFooter />
    </main>
    </>
  );
}
