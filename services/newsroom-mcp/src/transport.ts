/**
 * Newsroom MCP transport layer.
 *
 * Two local servers run side by side:
 *
 *  1. A WebSocket control channel on 127.0.0.1:9777. An avatar-live "studio"
 *     (the browser app that owns the live Three.js scene) connects here and
 *     performs the {@link BridgeRegister} handshake. Once registered, the MCP
 *     tool modules drive the studio by sending {@link BridgeRequest}s and
 *     awaiting the matching {@link BridgeResult} (correlated by `id`).
 *
 *  2. A sibling HTTP upload server on 127.0.0.1:9778. Tools that need to hand a
 *     binary blob (a recorded mp4, a screenshot, an asset) to the studio POST it
 *     to `/upload/<kind>/<id>`; the body is written into a per-process working
 *     dir and the local path is returned by {@link uploadedPath}.
 *
 * Only one studio is tracked at a time (the most recently registered socket).
 * This is intentional: a single MCP server drives a single studio session.
 */

import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  parseBridgeRegister,
  parseBridgeResult,
  type BridgeCommand,
  type BridgeCommandName,
  type BridgeRequest,
  type BridgeResult,
} from '@las/protocol';

// ---------------------------------------------------------------------------
// Configuration.
// ---------------------------------------------------------------------------

export const BRIDGE_WS_PORT = 9777;
export const UPLOAD_HTTP_PORT = 9778;
const BRIDGE_HOST = '127.0.0.1';

/** Default per-call timeout for a bridge round-trip (ms). */
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/** Working directory uploads are written into. */
const WORK_DIR = join(tmpdir(), 'newsroom-mcp');

// ---------------------------------------------------------------------------
// Connected-studio state.
// ---------------------------------------------------------------------------

interface ConnectedStudio {
  socket: WebSocket;
  studioId: string;
  capabilities: string[];
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** The single currently-registered studio, if any. */
let studio: ConnectedStudio | null = null;

/** In-flight bridge requests keyed by correlation id. */
const pending = new Map<string, Pending>();

/** Resolvers for {@link waitForStudio} callers awaiting a registration. */
let studioWaiters: Array<(s: ConnectedStudio) => void> = [];

let wss: WebSocketServer | null = null;
let httpServer: HttpServer | null = null;

// ---------------------------------------------------------------------------
// WS bridge server.
// ---------------------------------------------------------------------------

function handleStudioMessage(socket: WebSocket, raw: Buffer | ArrayBuffer | Buffer[]): void {
  let parsed: unknown;
  try {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString('utf8')
      : Buffer.from(raw as ArrayBuffer).toString('utf8');
    parsed = JSON.parse(text);
  } catch {
    return; // ignore non-JSON frames
  }

  // Registration handshake?
  if (
    parsed &&
    typeof parsed === 'object' &&
    (parsed as { type?: unknown }).type === 'register'
  ) {
    let reg;
    try {
      reg = parseBridgeRegister(parsed);
    } catch {
      return; // malformed register, ignore
    }
    studio = { socket, studioId: reg.studioId, capabilities: reg.capabilities ?? [] };
    const waiters = studioWaiters;
    studioWaiters = [];
    for (const w of waiters) w(studio);
    return;
  }

  // Otherwise it should be a BridgeResult correlated to a pending request.
  let result: BridgeResult;
  try {
    result = parseBridgeResult(parsed);
  } catch {
    return; // not a recognizable result envelope
  }
  const entry = pending.get(result.id);
  if (!entry) return;
  pending.delete(result.id);
  clearTimeout(entry.timer);
  if (result.ok) {
    entry.resolve(result.result);
  } else {
    entry.reject(new Error(result.error));
  }
}

/**
 * Start the WS bridge server (idempotent). Resolves once the server is
 * listening on {@link BRIDGE_WS_PORT}.
 */
export function startBridgeServer(): Promise<void> {
  if (wss) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const server = new WebSocketServer({ host: BRIDGE_HOST, port: BRIDGE_WS_PORT });
    server.on('connection', (socket: WebSocket) => {
      socket.on('message', (data) => handleStudioMessage(socket, data as Buffer));
      socket.on('close', () => {
        if (studio && studio.socket === socket) studio = null;
      });
      socket.on('error', () => {
        if (studio && studio.socket === socket) studio = null;
      });
    });
    server.on('listening', () => {
      wss = server;
      resolve();
    });
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// HTTP upload server.
// ---------------------------------------------------------------------------

/** Map of `<kind>/<id>` upload refs → the local file path they were written to. */
const uploads = new Map<string, string>();

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
  return `http://${BRIDGE_HOST}:${UPLOAD_HTTP_PORT}/asset/${id}`;
}

/** Resolve a served-asset id (or a path that was registered) to its local file path. */
export function assetPath(idOrPath: string): string | undefined {
  return assets.get(idOrPath) ?? (assetIdByPath.has(idOrPath) ? idOrPath : undefined);
}

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

function extForKind(kind: string): string {
  switch (kind) {
    case 'mp4':
    case 'video':
      return 'mp4';
    case 'png':
    case 'screenshot':
      return 'png';
    case 'jpg':
    case 'jpeg':
      return 'jpg';
    case 'wav':
    case 'audio':
      return 'wav';
    default:
      return 'bin';
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Start the HTTP upload server (idempotent). Accepts
 * `POST /upload/<kind>/<id>` and writes the raw body to
 * `<tmpdir>/newsroom-mcp/<id>.<ext>`, returning 200 with the path as JSON.
 */
export function startUploadServer(): Promise<void> {
  if (httpServer) return Promise.resolve();
  mkdirSync(WORK_DIR, { recursive: true });
  return new Promise<void>((resolve, reject) => {
    const server = createServer((req, res) => {
      void (async () => {
        // The browser studio (e.g. http://localhost:5175) POSTs binary uploads here
        // cross-origin (different host/port), which triggers a CORS preflight. Allow
        // any origin and answer OPTIONS, else the browser blocks the upload ("Failed
        // to fetch"). This sink is bound to 127.0.0.1 only, so * is acceptable.
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        if (req.method === 'OPTIONS') {
          res.writeHead(204).end();
          return;
        }
        // GET /asset/<id> — stream a registered (or work-dir) file cross-origin so
        // the browser studio can load generated media.
        if (req.method === 'GET' && req.url?.startsWith('/asset/')) {
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
          return;
        }
        if (req.method !== 'POST' || !req.url?.startsWith('/upload/')) {
          res.writeHead(404).end();
          return;
        }
        // /upload/<kind>/<id>
        const parts = req.url.split('/').filter(Boolean); // ['upload', kind, id]
        if (parts.length < 3) {
          res.writeHead(400).end('bad upload path');
          return;
        }
        const kind = parts[1]!;
        const id = parts[2]!;
        try {
          const body = await readBody(req);
          const ext = extForKind(kind);
          const path = join(WORK_DIR, `${id}.${ext}`);
          writeFileSync(path, body);
          uploads.set(`${kind}/${id}`, path);
          uploads.set(id, path);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, path }));
        } catch (err) {
          res.writeHead(500).end(String(err));
        }
      })();
    });
    server.on('listening', () => {
      httpServer = server;
      resolve();
    });
    server.on('error', reject);
    server.listen(UPLOAD_HTTP_PORT, BRIDGE_HOST);
  });
}

/**
 * Resolve an upload ref (either `<kind>/<id>` or a bare `<id>`) to the local
 * path the HTTP server wrote it to, or `undefined` if no such upload exists.
 */
export function uploadedPath(ref: string): string | undefined {
  return uploads.get(ref);
}

/** The working directory uploads are written into. */
export function workDir(): string {
  return WORK_DIR;
}

// ---------------------------------------------------------------------------
// Studio registration awaiting.
// ---------------------------------------------------------------------------

export interface WaitForStudioOptions {
  /** Max time to wait for a studio to register (ms). Default 60s. */
  timeoutMs?: number;
}

/** Whether a studio is currently registered. */
export function hasStudio(): boolean {
  return studio !== null;
}

/** Info about the currently-registered studio, if any. */
export function studioInfo(): { studioId: string; capabilities: string[] } | null {
  return studio ? { studioId: studio.studioId, capabilities: studio.capabilities } : null;
}

/**
 * Resolve once a studio has registered over the bridge. If one is already
 * connected, resolves immediately. Rejects on timeout.
 */
export function waitForStudio(opts: WaitForStudioOptions = {}): Promise<{
  studioId: string;
  capabilities: string[];
}> {
  if (studio) {
    return Promise.resolve({ studioId: studio.studioId, capabilities: studio.capabilities });
  }
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      studioWaiters = studioWaiters.filter((w) => w !== onRegister);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for a studio to register`));
    }, timeoutMs);
    const onRegister = (s: ConnectedStudio): void => {
      clearTimeout(timer);
      resolve({ studioId: s.studioId, capabilities: s.capabilities });
    };
    studioWaiters.push(onRegister);
  });
}

// ---------------------------------------------------------------------------
// callBridge — the helper every tool module uses.
// ---------------------------------------------------------------------------

export interface CallBridgeOptions {
  /** Round-trip timeout (ms). Default 120s. */
  timeoutMs?: number;
}

/**
 * Send a {@link BridgeRequest} to the connected studio and await the matching
 * {@link BridgeResult}. Resolves with the result payload on success, throws on
 * a studio-reported error or on timeout. Throws immediately if no studio is
 * connected.
 *
 * @param cmd    The bridge command name (see {@link BridgeCommandName}).
 * @param params The command's params object.
 * @param opts   Optional timeout override.
 */
export function callBridge<T = unknown>(
  cmd: BridgeCommandName,
  params: unknown,
  opts: CallBridgeOptions = {},
): Promise<T> {
  if (!studio) {
    return Promise.reject(new Error('No studio connected. Call connect_studio first.'));
  }
  const id = randomUUID();
  // `BridgeRequest` is `{ id } & BridgeCommand`; we trust the caller's
  // cmd/params pairing (the studio re-validates with parseBridgeRequest).
  const request = { id, cmd, params } as unknown as BridgeRequest;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const socket = studio.socket;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Bridge command "${cmd}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (r) => resolve(r as T),
      reject,
      timer,
    });
    try {
      socket.send(JSON.stringify(request));
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Build a typed bridge command pair (helps tool modules stay in sync). */
export type { BridgeCommand };

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

/** Start both transport servers (WS bridge + HTTP upload). Idempotent. */
export async function startTransport(): Promise<void> {
  await Promise.all([startBridgeServer(), startUploadServer()]);
}

/** Tear down both servers and reject any in-flight requests. */
export async function stopTransport(): Promise<void> {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error('Transport shutting down'));
  }
  pending.clear();
  studio = null;
  await Promise.all([
    new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve())),
    new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve())),
  ]);
  wss = null;
  httpServer = null;
}
