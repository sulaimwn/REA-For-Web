'use client';
import { useEffect, useRef, useState } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  MAX_UPLOAD_BYTES,
  type UploadTicket,
} from '@rea-studio/pipeline/contracts';
import { useRouter } from 'next/navigation';

export function UploadForm() {
  const [file, setFile] = useState<File | null>(null),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [accessKey, setAccessKey] = useState('');
  const controller = useRef<AbortController | null>(null);
  const [canCancel, setCanCancel] = useState(false);
  useEffect(() => () => controller.current?.abort(), []);
  const router = useRouter();
  async function start() {
    if (!file) return;
    if (
      !/\.asar$/iu.test(file.name) ||
      file.size < 1 ||
      file.size > MAX_UPLOAD_BYTES
    ) {
      setMessage('Choose an .asar file up to 512 MB.');
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setCanCancel(true);
    try {
      const hash = sha256.create();
      for (let offset = 0; offset < file.size; offset += 4 * 1024 * 1024) {
        abort.signal.throwIfAborted();
        hash.update(
          new Uint8Array(
            await file.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer(),
          ),
        );
        setMessage(
          `Preparing file… ${Math.min(100, Math.round(((offset + 4 * 1024 * 1024) / file.size) * 100))}%`,
        );
      }
      const common = {
        'Content-Type': 'application/json',
        ...(accessKey ? { 'X-REA-Access-Key': accessKey } : {}),
      };
      const response = await fetch('/api/uploads', {
        method: 'POST',
        headers: common,
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
      const uploaded = await fetch(ticket.uploadUrl, {
        method: 'PUT',
        headers: ticket.headers,
        body: file,
        signal: abort.signal,
      });
      if (!uploaded.ok) throw new Error('Upload failed. Please try again.');
      setMessage('Starting analysis…');
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
      setMessage(
        abort.signal.aborted
          ? 'Upload cancelled.'
          : error instanceof Error
            ? error.message
            : 'Upload failed.',
      );
    } finally {
      setBusy(false);
      setCanCancel(false);
      controller.current = null;
    }
  }
  return (
    <section className="upload-form" aria-label="Upload an app">
      <label htmlFor="app-file">Choose an Electron app archive</label>
      <input
        id="app-file"
        type="file"
        accept=".asar"
        disabled={busy}
        onChange={(event) => {
          setFile(event.target.files?.[0] ?? null);
          setMessage('');
        }}
      />
      <p className="muted">
        .asar files up to 512 MB. Static analysis only. The uploaded app is
        never run.
      </p>
      <details>
        <summary>Private beta access key</summary>
        <input
          type="password"
          aria-label="Upload access key"
          autoComplete="off"
          value={accessKey}
          onChange={(event) => setAccessKey(event.target.value)}
          disabled={busy}
        />
      </details>
      <button
        type="button"
        className="chip"
        disabled={!file || busy}
        onClick={() => void start()}
      >
        Analyze app
      </button>
      {busy && canCancel && (
        <button
          type="button"
          className="chip"
          onClick={() => controller.current?.abort()}
        >
          Cancel upload
        </button>
      )}
      <p role="status" aria-live="polite">
        {message}
      </p>
      <p className="muted">
        Raw uploads are deleted after analysis. Unfinished uploads are removed
        by expiry cleanup. Results stay private to this browser session.
      </p>
    </section>
  );
}
