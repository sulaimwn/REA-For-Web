'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { StudioProject } from '@rea-studio/schema';
import type { JobStatus } from '@rea-studio/pipeline/contracts';
import { Explorer } from './Explorer';

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
          setProject((await result.json()) as StudioProject);
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
      <Explorer
        key={id}
        initialProject={project}
        demo={{
          slug: id,
          title: project.target.name,
          blurb: 'Your uploaded app',
          name: project.target.name,
          version: project.target.version,
          nodes: project.nodes.length,
          edges: project.edges.length,
          coverage: project.analysis.coverage.status,
          sample: null,
        }}
      />
    );
  return (
    <main className="landing">
      <Link href="/upload">← Upload an app</Link>
      <h1>
        {error || status?.status === 'failed'
          ? 'Analysis unavailable'
          : 'Analyzing your app'}
      </h1>
      <p role="status" aria-live="polite">
        {error ??
          status?.error ??
          status?.progress?.message ??
          (status?.status === 'queued'
            ? 'Waiting for the analysis worker…'
            : 'Checking analysis status…')}
      </p>
      <p className="muted">You can reload this page while analysis runs.</p>
    </main>
  );
}
