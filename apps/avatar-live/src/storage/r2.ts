// Browser client for the dev-server R2 proxy (see vite.config.ts `/r2/*`).
// Secrets stay server-side; this just talks to the local proxy. All functions
// throw on failure so callers can fall back (e.g. to localStorage).

function encodePath(key: string): string {
  return key
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

/** True if the dev server has R2 configured (R2_* in .env). Requires a JSON
 *  response — a static host's SPA fallback returns 200 text/html, which must NOT
 *  be mistaken for a working backend (else saves would silently go nowhere). */
export async function r2Available(): Promise<boolean> {
  try {
    const r = await fetch('/r2/list?prefix=__probe__/');
    return r.ok && (r.headers.get('content-type') || '').includes('application/json');
  } catch {
    return false;
  }
}

export async function r2List(prefix: string): Promise<string[]> {
  const r = await fetch(`/r2/list?prefix=${encodeURIComponent(prefix)}`);
  if (!r.ok) throw new Error(`r2 list ${r.status}`);
  return ((await r.json()) as { keys: string[] }).keys;
}

export async function r2PutJson(key: string, obj: unknown): Promise<void> {
  const r = await fetch(`/r2/o/${encodePath(key)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  });
  if (!r.ok) throw new Error(`r2 put ${r.status}`);
}

export async function r2PutBlob(key: string, blob: Blob): Promise<void> {
  const r = await fetch(`/r2/o/${encodePath(key)}`, {
    method: 'PUT',
    headers: { 'content-type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  if (!r.ok) throw new Error(`r2 put ${r.status}`);
}

export async function r2GetJson<T>(key: string): Promise<T> {
  const r = await fetch(`/r2/o/${encodePath(key)}`);
  if (!r.ok) throw new Error(`r2 get ${r.status}`);
  return (await r.json()) as T;
}

export async function r2GetBlob(key: string): Promise<Blob> {
  const r = await fetch(`/r2/o/${encodePath(key)}`);
  if (!r.ok) throw new Error(`r2 get ${r.status}`);
  return r.blob();
}

/** Same-origin URL the browser can stream directly (e.g. a <video> src). */
export function r2Url(key: string): string {
  return `/r2/o/${encodePath(key)}`;
}

/** Resolve an asset `src` that may be a bare R2 key: absolute/rooted/blob/data URLs pass
 *  through untouched; anything else is treated as an R2 key (the shape authored newscasts
 *  store). One shared rule so the audio, slide, and project paths can't drift. */
export function resolveAssetUrl(src: string): string {
  return /^https?:\/\//.test(src) || src.startsWith('/') || src.startsWith('blob:') || src.startsWith('data:')
    ? src
    : r2Url(src);
}
