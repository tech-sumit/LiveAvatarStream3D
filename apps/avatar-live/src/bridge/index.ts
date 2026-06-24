// Studio Bridge — a reconnecting WebSocket client that lets a remote driver (the
// Newsroom MCP server) control this avatar-live studio over the BridgeCommand
// protocol defined in @las/protocol's bridge.ts.
//
// OFF by default: initBridge() is a no-op unless the bridge is explicitly enabled
// via `?bridge=<port>` in the URL or the VITE_BRIDGE build env. When disabled it
// opens no socket and touches no studio state, so the default app is unaffected.
import { parseBridgeRequest, bridgeOk, bridgeError, type BridgeRegister, type BridgeResult } from '@las/protocol';
import type { StudioContext } from '../app/context.js';
import { createDispatcher, setActiveReqId, type BridgeControllers } from './dispatch.js';

const DEFAULT_PORT = 9777;
const STUDIO_ID = 'avatar-live';

/** Resolve the bridge port if enabled, else null (disabled — the common case). */
function resolveBridgePort(): number | null {
  const q = new URLSearchParams(location.search).get('bridge');
  const env = (import.meta.env.VITE_BRIDGE as string | undefined) ?? undefined;
  const raw = q ?? env;
  if (raw == null || raw === '') return null;
  // A bare flag (?bridge with no value, or VITE_BRIDGE=1/true) → default port.
  const n = Number(raw);
  if (raw === '1' || raw === 'true') return DEFAULT_PORT;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

/**
 * Connect the studio to the bridge if enabled. Returns immediately; the socket
 * connects (and reconnects) in the background. No-op when disabled.
 */
export function initBridge(app: StudioContext, controllers: BridgeControllers): void {
  const port = resolveBridgePort();
  if (port == null) return; // disabled — default behaviour, no socket.

  const url = `ws://127.0.0.1:${port}`;
  const dispatch = createDispatcher(app, controllers);
  const capabilities = [
    'applyNewscast',
    'patchNewscast',
    'validateNewscast',
    'setScript',
    'setVoice',
    'setAvatar',
    'setEmotion',
    'setLighting',
    'setLook',
    'setCaptureFormat',
    'addCue',
    'updateCue',
    'removeCue',
    'listCues',
    'captureView',
    'setTimelineLength',
    'clearTimeline',
    'setHeadline',
    'setBackscreenMedia',
    'getState',
    'screenshot',
    'preview',
    'exportMp4',
    'executeJs',
  ];

  let ws: WebSocket | null = null;
  let reconnectMs = 1000;
  const MAX_RECONNECT_MS = 15000;
  let closed = false;

  const connect = (): void => {
    if (closed) return;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      app.log(`bridge: connect failed (${String(err)}) — retrying…`);
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      reconnectMs = 1000;
      const register: BridgeRegister = { type: 'register', studioId: STUDIO_ID, capabilities };
      ws?.send(JSON.stringify(register));
      app.log(`bridge: connected to ${url}`);
    });

    ws.addEventListener('message', (ev) => void onMessage(String(ev.data)));

    ws.addEventListener('close', () => {
      app.log('bridge: disconnected — reconnecting…');
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // 'error' is followed by 'close', which drives the reconnect; just close.
      try {
        ws?.close();
      } catch {
        /* already closing */
      }
    });
  };

  const onMessage = async (data: string): Promise<void> => {
    let reqId = 'unknown';
    let reply: BridgeResult;
    try {
      const parsed: unknown = JSON.parse(data);
      const req = parseBridgeRequest(parsed);
      reqId = req.id;
      setActiveReqId(reqId); // screenshot/export uploads name their sink ref after this id
      const result = await dispatch(req.cmd, (req as { params?: Record<string, unknown> }).params ?? {});
      reply = bridgeOk(reqId, result);
    } catch (err) {
      reply = bridgeError(reqId, String(err instanceof Error ? err.message : err));
    }
    try {
      ws?.send(JSON.stringify(reply));
    } catch {
      /* socket closed mid-flight; the reconnect will re-register */
    }
  };

  const scheduleReconnect = (): void => {
    if (closed) return;
    const delay = reconnectMs;
    reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
    setTimeout(connect, delay);
  };

  // Tidy up on navigation so a reload doesn't leak a half-open socket.
  window.addEventListener('beforeunload', () => {
    closed = true;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  });

  app.log(`bridge: enabled → ${url} (studio "${STUDIO_ID}")`);
  connect();
}
