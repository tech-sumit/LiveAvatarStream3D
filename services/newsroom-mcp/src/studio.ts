/**
 * Studio connection — the bridge between the MCP server and an avatar-live
 * studio (the browser app that owns the live Three.js scene).
 *
 * Two modes:
 *
 *  - ATTENDED: the human has already opened the avatar-live studio in a real
 *    browser tab with the bridge enabled (`?bridge=9777`). We simply ensure the
 *    transport servers are up and wait for that studio to register.
 *
 *  - HEADLESS: there is no human-driven tab, so we launch a Playwright Chromium
 *    instance ourselves, navigate it to the studio URL with `?bridge=9777`, and
 *    wait for it to register. The browser/page handle is kept so the session can
 *    be torn down later.
 */

import type { Browser } from 'playwright';
import { startTransport, waitForStudio, BRIDGE_WS_PORT } from './transport.js';

export type StudioMode = 'attended' | 'headless';

export interface ConnectStudioOptions {
  mode: StudioMode;
  /** Studio URL (headless mode). Default http://localhost:5175. */
  studioUrl?: string;
  /** Run the launched browser headless (headless mode). Default true. */
  headless?: boolean;
  /** Max time to wait for the studio to register (ms). Default 90s. */
  timeoutMs?: number;
}

export interface StudioSession {
  mode: StudioMode;
  studioId: string;
  capabilities: string[];
  /** Tear down anything this session owns (the headless browser, if any). */
  close(): Promise<void>;
}

const DEFAULT_STUDIO_URL = 'http://localhost:5175';
const DEFAULT_CONNECT_TIMEOUT_MS = 90_000;

/** The active session, if any. Only one studio is driven at a time. */
let active: StudioSession | null = null;

/**
 * Connect to (or launch) an avatar-live studio and wait for it to register over
 * the bridge. Returns once a studio is registered and ready to receive
 * commands.
 */
export async function connectStudio(opts: ConnectStudioOptions): Promise<StudioSession> {
  // Replace any prior session.
  if (active) {
    await active.close().catch(() => {});
    active = null;
  }

  // Both modes need the transport servers up.
  await startTransport();

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  let browser: Browser | null = null;

  if (opts.mode === 'headless') {
    const studioUrl = opts.studioUrl ?? DEFAULT_STUDIO_URL;
    const headless = opts.headless ?? true;
    // Lazy import keeps Playwright off the startup path (and out of attended mode).
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless });
    try {
      const page = await browser.newPage();
      const sep = studioUrl.includes('?') ? '&' : '?';
      await page.goto(`${studioUrl}${sep}bridge=${BRIDGE_WS_PORT}`, {
        waitUntil: 'domcontentloaded',
      });
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
  }
  // ATTENDED: nothing to launch — the human opened the studio themselves.

  let registered;
  try {
    registered = await waitForStudio({ timeoutMs });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw err;
  }

  const capturedBrowser = browser;
  const session: StudioSession = {
    mode: opts.mode,
    studioId: registered.studioId,
    capabilities: registered.capabilities,
    async close() {
      if (capturedBrowser) await capturedBrowser.close().catch(() => {});
      if (active === session) active = null;
    },
  };
  active = session;
  return session;
}

/** The currently-active studio session, if any. */
export function activeStudio(): StudioSession | null {
  return active;
}

/** Tear down the active studio session (closes a headless browser if present). */
export async function disconnectStudio(): Promise<void> {
  if (active) {
    await active.close().catch(() => {});
    active = null;
  }
}
