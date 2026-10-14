'use client';
import { useEffect, useRef, useState } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_ACCEPT,
  UPLOAD_FILE_ERROR,
  uploadKind,
  type UploadTicket,
} from '@rea-studio/pipeline/contracts';
import { useRouter } from 'next/navigation';
import { uploadFile } from '../lib/upload-file';
import { requestUploadChallenge } from '../lib/upload-challenge';

export function UploadForm({ publicSiteKey, publicUploads = false }: { publicSiteKey?: string | undefined; publicUploads?: boolean }) {
  const [file, setFile] = useState<File | null>(null),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [accessKey, setAccessKey] = useState('');
  const controller = useRef<AbortController | null>(null);
  const challengeContainer = useRef<HTMLDivElement | null>(null);
  const [canCancel, setCanCancel] = useState(false);
  const [progress, setProgress] = useState<{ phase: 'preparing' | 'uploading'; loaded: number; total: number } | null>(null);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);
  const router = useRouter();
  async function start() {
    if (!file || controller.current) return;
    if (
      !uploadKind(file.name) ||
      file.size < 1 ||
      file.size > MAX_UPLOAD_BYTES
    ) {
      setMessage(UPLOAD_FILE_ERROR);
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setCanCancel(true);
    setProgress({ phase: 'preparing', loaded: 0, total: file.size });
    try {
      const hash = sha256.create();
      for (let offset = 0; offset < file.size; offset += 4 * 1024 * 1024) {
        abort.signal.throwIfAborted();
        hash.update(
          new Uint8Array(
            await file.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer(),
          ),
        );
        abort.signal.throwIfAborted();
        setProgress({ phase: 'preparing', loaded: Math.min(file.size, offset + 4 * 1024 * 1024), total: file.size });
        setMessage(
          `Preparing file… ${Math.min(100, Math.round(((offset + 4 * 1024 * 1024) / file.size) * 100))}%`,
        );
      }
      const ownerKey = accessKey.trim();
      let challengeToken: string | undefined;
      if (publicSiteKey && !ownerKey) {
        if (!challengeContainer.current) throw new Error('The security check is unavailable. Please try again.');
        setProgress(null);
        setMessage('Complete the security check to continue.');
        challengeToken = await requestUploadChallenge(challengeContainer.current, publicSiteKey, abort.signal);
      }
      abort.signal.throwIfAborted();
      const common = {
        'Content-Type': 'application/json',
        ...(ownerKey ? { 'X-REA-Access-Key': ownerKey } : {}),
      };
      const response = await fetch('/api/uploads', {
        method: 'POST',
        headers: { ...common, ...(challengeToken ? { 'X-REA-Turnstile-Token': challengeToken } : {}) },
        body: JSON.stringify({
          name: file.name,
          bytes: file.size,
          sha256: bytesToHex(hash.digest()),
        }),
        signal: abort.signal,
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error ?? 'Could not prepare upload.');
      const ticket = payload as UploadTicket;
      sessionStorage.setItem(`rea-job:${ticket.jobId}`, ticket.jobToken);
      setMessage('Uploading…');
      setProgress({ phase: 'uploading', loaded: 0, total: file.size });
      await uploadFile(ticket.uploadUrl, ticket.headers, file, abort.signal, (loaded, total) => {
        if (controller.current !== abort) return;
        setProgress({ phase: 'uploading', loaded, total });
        setMessage(`Uploading… ${Math.floor((loaded / total) * 100)}% (${(loaded / 1024 / 1024).toFixed(1)} of ${(total / 1024 / 1024).toFixed(1)} MB)`);
      });
      abort.signal.throwIfAborted();
      setProgress(null);
      setMessage('Upload received. Verifying the file and starting analysis…');
      setCanCancel(false);
      const queued = await fetch(`/api/uploads/${ticket.jobId}/complete`, {
        method: 'POST',
        headers: { ...common, Authorization: `Bearer ${ticket.jobToken}` },
        signal: abort.signal,
      });
      if (!queued.ok)
        throw new Error(
          (await queued.json()).error ?? 'Could not start analysis.',
        );
      router.push(`/jobs/${ticket.jobId}`);
    } catch (error) {
      if (controller.current !== abort) return;
      setMessage(
        abort.signal.aborted
          ? 'Upload cancelled.'
          : error instanceof Error
            ? error.message
            : 'Upload failed.',
      );
    } finally {
      if (controller.current === abort) {
        setBusy(false);
        setCanCancel(false);
        setProgress(null);
        controller.current = null;
      }
    }
  }
  return (
    <section className="upload-form" aria-label="Upload an app">
      <label htmlFor="app-file">Choose an application file</label>
      <input
        id="app-file"
        type="file"
        accept={UPLOAD_ACCEPT}
        disabled={busy}
        onChange={(event) => {
          setFile(event.target.files?.[0] ?? null);
          setMessage('');
          setProgress(null);
        }}
      />
      <p className="muted">
        Electron .asar, Windows .exe/.dll, Android .apk, Linux .elf/.so, or single-architecture macOS .macho/.dylib files up to 512 MB. The uploaded app is
        never run.
      </p>
      <details>
        <summary>{publicUploads ? 'Optional access key' : 'Private beta access key'}</summary>
        <input
          type="password"
          aria-label="Upload access key"
          autoComplete="off"
          value={accessKey}
          onChange={(event) => setAccessKey(event.target.value)}
          disabled={busy}
        />
      </details>
      {publicSiteKey ? <div ref={challengeContainer} aria-label="Upload security check" /> : null}
      <button
        type="button"
        className="btn btn--primary"
        disabled={!file || busy}
        onClick={() => void start()}
      >
        Analyze app
      </button>
      {busy && canCancel && (
        <button
          type="button"
          className="btn"
          onClick={() => controller.current?.abort()}
        >
          Cancel upload
        </button>
      )}
      <p role="status" aria-live="polite">
        {message}
      </p>
      {busy && progress && (
        <progress className="upload-progress" value={progress.loaded} max={progress.total}
          aria-label={progress.phase === 'preparing' ? 'Preparing file progress' : 'File upload progress'} />
      )}
      <p className="muted">
        Raw uploads are deleted after analysis. Unfinished uploads are removed
        by expiry cleanup. Results stay private to this browser session.
      </p>
    </section>
  );
}
