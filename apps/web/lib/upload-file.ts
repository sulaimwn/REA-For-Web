/** Upload bytes with native progress events. Completion still requires a successful HTTP response. */
export function uploadFile(
  url: string, headers: Record<string, string>, file: File, signal: AbortSignal,
  onProgress: (loaded: number, total: number) => void,
  createRequest: () => XMLHttpRequest = () => new XMLHttpRequest(),
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const request = createRequest();
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      request.onload = request.onerror = request.onabort = request.ontimeout = null;
      request.upload.onprogress = null;
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => {
      request.abort();
      finish(signal.reason ?? new DOMException('Upload cancelled.', 'AbortError'));
    };
    try {
      request.open('PUT', url);
      request.timeout = 10 * 60 * 1000;
      for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
      request.upload.onprogress = (event) => onProgress(Math.min(file.size, Math.max(0, event.loaded)), file.size);
      request.onload = () => {
        if (request.status >= 200 && request.status < 300) finish();
        else finish(new Error('Upload failed. Please try again.'));
      };
      request.onerror = () => finish(new Error('Could not upload the file. Check your connection and try again.'));
      request.ontimeout = () => finish(new Error('The upload took too long. Please try again.'));
      request.onabort = () => finish(new DOMException('Upload cancelled.', 'AbortError'));
      signal.addEventListener('abort', cancel, { once: true });
      request.send(file);
    } catch (error) { finish(error); }
  });
}
