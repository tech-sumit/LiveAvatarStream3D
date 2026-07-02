/**
 * Newsroom MCP — local asset store + HTTP asset server.
 *
 * Generated assets (card PNGs, montage MP4s, music WAVs, post-produced masters,
 * external provider downloads) are written into a per-process work dir and
 * served read-only over loopback HTTP:
 *
 *   GET http://127.0.0.1:9778/asset/<id>
 *
 * The server exists so the *browser* studio can load generated media: a caller
 * takes the `url` a tool returns and applies it in the studio via the studio's
 * own WebMCP tools (e.g. `set_backscreen_media`). This service does NOT talk to
 * the studio itself — the old Studio Bridge (WS on 9777 + the POST /upload sink)
 * was retired in favor of the in-browser WebMCP server
 * (docs/specs/2026-06-25-webmcp-studio-control-design.md).
 *
 * CORS is wide open on purpose: the server binds to 127.0.0.1 only and serves
 * nothing but files this process generated.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Configuration.
// ---------------------------------------------------------------------------

export const ASSET_HTTP_PORT = 9778;
const ASSET_HOST = '127.0.0.1';

/** Working directory generated assets are written into. */
const WORK_DIR = join(tmpdir(), 'newsroom-mcp');

/** The work dir path (created on first use). */
export function workDir(): string {
  mkdirSync(WORK_DIR, { recursive: true });
  return WORK_DIR;
}

// ---------------------------------------------------------------------------
// Asset registry.
// ---------------------------------------------------------------------------

/** Map of asset id → local file path, for files served via `GET /asset/<id>`. */
const assets = new Map<string, string>();

/** Reverse index: local path → asset id, so registering the same path is stable. */
const assetIdByPath = new Map<string, string>();

/**
 * Register a local file under a served asset id (idempotent per path). Returns
 * the id; serve it via `GET /asset/<id>` or build the URL with {@link assetUrl}.
 */
export function registerAsset(localPath: string): string {
  const existing = assetIdByPath.get(localPath);
  if (existing) return existing;
  const ext = extname(localPath).replace(/^\./, '').toLowerCase();
  const id = ext ? `${randomUUID()}.${ext}` : randomUUID();
  assets.set(id, localPath);
  assetIdByPath.set(localPath, id);
  return id;
}

/**
 * Resolve a served-asset URL for a registered id or a local path. If a path is
 * passed it is registered first. Returns `http://127.0.0.1:9778/asset/<id>`.
 */
export function assetUrl(idOrPath: string): string {
  // If it's a known id, use it directly.
  let id = idOrPath;
  if (!assets.has(idOrPath)) {
    // Treat it as a path: register (or reuse) it.
    id = registerAsset(idOrPath);
  }
  return `http://${ASSET_HOST}:${ASSET_HTTP_PORT}/asset/${id}`;
}

/** Resolve a served-asset id (or a path that was registered) to its local file path. */
export function assetPath(idOrPath: string): string | undefined {
  return assets.get(idOrPath) ?? (assetIdByPath.has(idOrPath) ? idOrPath : undefined);
}

/** Every registered asset: its id, served URL, and local path. */
export function listAssets(): Array<{ id: string; url: string; path: string }> {
  return [...assets.entries()].map(([id, path]) => ({
    id,
    url: `http://${ASSET_HOST}:${ASSET_HTTP_PORT}/asset/${id}`,
    path,
  }));
}

// ---------------------------------------------------------------------------
// HTTP asset server (GET /asset/<id> only).
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  json: 'application/json',
};

function contentTypeForPath(path: string): string {
  const ext = extname(path).replace(/^\./, '').toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

let httpServer: HttpServer | null = null;

/**
 * Start the HTTP asset server (idempotent). Serves `GET /asset/<id>` from the
 * registry (or a bare filename in the work dir) with permissive CORS so the
 * browser studio can load generated media cross-origin.
 */
export function startAssetServer(): Promise<void> {
  if (httpServer) return Promise.resolve();
  workDir(); // ensure the work dir exists up front
  return new Promise<void>((resolve, reject) => {
    const server = createServer((req, res) => {
      // The browser studio (e.g. http://localhost:5175) fetches assets here
      // cross-origin. Allow any origin: loopback-only, read-only, our files only.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
      if (req.method !== 'GET' || !req.url?.startsWith('/asset/')) {
        res.writeHead(404).end();
        return;
      }
      const id = decodeURIComponent(req.url.slice('/asset/'.length).split('?')[0] ?? '');
      // Resolve: a registered asset id, a registered local path, or a bare
      // filename in WORK_DIR. Reject anything that escapes WORK_DIR.
      let path = assets.get(id);
      if (!path && assetIdByPath.has(id)) path = id;
      if (!path && id && !id.includes('/') && !id.includes('..')) {
        const candidate = join(WORK_DIR, id);
        if (existsSync(candidate)) path = candidate;
      }
      if (!path && isAbsolute(id) && assetIdByPath.has(id)) path = id;
      if (!path || !existsSync(path)) {
        res.writeHead(404).end('asset not found');
        return;
      }
      const size = statSync(path).size;
      res.writeHead(200, {
        'content-type': contentTypeForPath(path),
        'content-length': size,
        'cache-control': 'no-store',
      });
      createReadStream(path)
        .on('error', () => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        })
        .pipe(res);
    });
    server.on('listening', () => {
      httpServer = server;
      resolve();
    });
    server.on('error', reject);
    server.listen(ASSET_HTTP_PORT, ASSET_HOST);
  });
}

/** Stop the asset server (idempotent). */
export async function stopAssetServer(): Promise<void> {
  await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()));
  httpServer = null;
}
