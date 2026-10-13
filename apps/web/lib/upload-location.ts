/** Public navigation only; never forward keys or job tokens between sites. */
export function uploadLocation(env: Record<string, string | undefined> = process.env): string | undefined {
  if (['local', 'r2'].includes(env.PIPELINE_STORAGE ?? '')) return '/upload';
  if (!env.REA_UPLOAD_ORIGIN) return undefined;
  try {
    const url = new URL(env.REA_UPLOAD_ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return undefined;
    return `${url.origin}/upload`;
  } catch { return undefined; }
}
