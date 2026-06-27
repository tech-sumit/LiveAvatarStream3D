#!/usr/bin/env node
// Launch a WebMCP-enabled Chrome for the chrome-devtools-mcp bridge (connect mode).
//
// chrome-devtools-mcp's own launch mode does NOT reliably apply `--chrome-arg=--enable-features`
// (Puppeteer passes its own `--enable-features`, and Chrome's last-one-wins drops ours), so the
// studio's `navigator.modelContext` never appears. The robust path is to launch Chrome here with
// the WebMCP features + a remote-debugging port, then point chrome-devtools-mcp at it via
// `--browser-url=http://127.0.0.1:9222`.
//
// Usage: node apps/avatar-live/scripts/webmcp-chrome.mjs [url] [--port 9222] [--headless]
//   url defaults to http://localhost:5175/ — the studio auto-registers its SAFE WebMCP tool set
//   when navigator.modelContext is present. Append `?webmcp=full` yourself ONLY if you need the
//   execute_js arbitrary-eval escape hatch (full studio-origin access — not the default).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';

const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const port = portFlag !== -1 ? args[portFlag + 1] : '9222';
const headless = args.includes('--headless');
const url = args.find((a) => /^https?:\/\//.test(a)) ?? 'http://localhost:5175/';

// Candidate stable-Chrome paths per OS (must be ≥149 for WebMCP).
const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'],
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ],
};

const bin = (CANDIDATES[platform()] ?? []).find((p) => existsSync(p));
if (!bin) {
  console.error(`No Chrome found for platform "${platform()}". Install Chrome 149+ and retry.`);
  process.exit(1);
}

const profile = `${process.env.TMPDIR ?? '/tmp'}/webmcp-chrome-profile`;
const chromeArgs = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--enable-features=WebMCP,DevToolsWebMCPSupport',
  '--no-first-run',
  '--no-default-browser-check',
  ...(headless ? ['--headless=new'] : []),
  url,
];

console.log(`Launching WebMCP Chrome:\n  ${bin}\n  port=${port} headless=${headless}\n  ${url}`);
console.log(`Then point chrome-devtools-mcp at it: --browser-url=http://127.0.0.1:${port}`);
const child = spawn(bin, chromeArgs, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
