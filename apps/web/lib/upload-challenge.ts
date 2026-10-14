type ChallengeAPI = {
  render(container: HTMLElement, options: {
    sitekey: string; action: string; callback: (token: string) => void;
    'error-callback': () => void; 'expired-callback': () => void;
  }): string;
  remove(id: string): void;
};
const api = () => (window as Window & { turnstile?: ChallengeAPI }).turnstile;
let loading: Promise<ChallengeAPI> | undefined;
function load(): Promise<ChallengeAPI> {
  const existing = api();
  if (existing) return Promise.resolve(existing);
  return loading ??= new Promise<ChallengeAPI>((resolve, reject) => {
    const script = document.createElement('script');
    const fail = () => {
      clearTimeout(timer); loading = undefined; script.remove();
      reject(new Error('The upload security check could not load. Please try again.'));
    };
    const timer = setTimeout(fail, 10000);
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => {
      const ready = api();
      if (!ready) { fail(); return; }
      clearTimeout(timer); resolve(ready);
    };
    script.onerror = fail;
    document.head.appendChild(script);
  });
}

// Hash first; every attempt gets a fresh single-use check. Cancellation removes it.
export async function requestUploadChallenge(container: HTMLElement, siteKey: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let cancelLoad: (() => void) | undefined;
  const challenge = await Promise.race([load(), new Promise<never>((_, reject) => {
    cancelLoad = () => reject(signal.reason);
    signal.addEventListener('abort', cancelLoad, { once: true });
  })]).finally(() => { if (cancelLoad) signal.removeEventListener('abort', cancelLoad); });
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    let widget: string | undefined;
    let settled = false;
    function finish(error?: Error, token?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (widget !== undefined) { try { challenge.remove(widget); } catch {} }
      if (error) reject(error); else resolve(token!);
    }
    const cancel = () => finish(signal.reason as Error);
    const timer = setTimeout(() => finish(new Error('The security check expired. Please try again.')), 300000);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      widget = challenge.render(container, { sitekey: siteKey, action: 'upload-app',
        callback: token => finish(undefined, token),
        'error-callback': () => finish(new Error('The security check failed. Please try again.')),
        'expired-callback': () => finish(new Error('The security check expired. Please try again.')),
      });
      if (settled) { try { challenge.remove(widget); } catch {} }
    } catch {
      finish(new Error('The upload security check could not start. Please try again.'));
    }
  });
}
