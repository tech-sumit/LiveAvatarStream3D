import type { VoiceProfile, VoiceStatus } from '@las/protocol';
import type { StudioContext } from './context.js';

// POC user — matches the control-api default (`userId` query param). See CLAUDE.md.
const USER_ID = 'demo-user';

/**
 * Resolve the **deployed** control-api base. Cloned voices live on the deployed
 * D1/R2 (CLAUDE.md gotcha), so these calls MUST hit the same Worker base the rest
 * of the studio is configured against via `VITE_API_URL`
 * (e.g. https://<your-worker>.workers.dev/api). The base already
 * includes the `/api` segment; we append `/voices…`. Trailing slashes trimmed so
 * `${base}/voices` never doubles up. Returns '' when unset → the manager renders a
 * loud "configure VITE_API_URL" state instead of fetching a wrong origin.
 */
function apiBase(): string {
  return (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');
}

/**
 * Retry is offered for any clone that isn't `ready` (failed / stuck `cloning` /
 * `pending`). The server still 400s if the row has no sample on file — surfaced
 * via the loud error path, never swallowed.
 */
export function retryEligible(status: VoiceStatus | string): boolean {
  return status !== 'ready';
}

/** Map a clone status to a sidebar `.badge` variant + display label. */
export function statusBadge(status: VoiceStatus | string): { label: string; cls: string } {
  switch (status) {
    case 'ready':
      return { label: 'ready', cls: 'success' };
    case 'cloning':
    case 'pending':
      return { label: status, cls: 'loading' };
    case 'failed':
      return { label: 'failed', cls: 'error' };
    default:
      return { label: String(status), cls: 'warning' };
  }
}

function formatCreated(ts: number | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '';
  try {
    return new Date(ts).toLocaleDateString();
  } catch {
    return '';
  }
}

/**
 * Cloned-voice manager — lists the user's D1 voice registry and lets them delete
 * (with an inline two-step confirm, never a blocking `window.confirm`) or retry a
 * stuck/failed clone. Mirrors {@link VoicePicker}'s conventions: a class taking the
 * shared {@link StudioContext} with an async `init()`/`refresh()`. All failures log
 * loudly via `app.log` and are NOT retried (project rule).
 */
export class VoiceManager {
  private voices: VoiceProfile[] = [];
  // The row currently awaiting a delete confirmation (inline yes/no), if any.
  private confirmingId: string | null = null;

  constructor(private app: StudioContext) {}

  async init(): Promise<void> {
    this.app.dom.voiceMgrRefreshBtn.addEventListener('click', () => void this.refresh());
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const base = apiBase();
    if (!base) {
      this.voices = [];
      this.confirmingId = null;
      this.renderMessage('Set VITE_API_URL (deployed Worker) to manage cloned voices.');
      this.app.log(
        'voice-manager: VITE_API_URL not set — cloned voices live on the deployed control-api; set it in apps/avatar-live/.env.',
      );
      return;
    }
    this.confirmingId = null;
    this.renderMessage('Loading cloned voices…');
    try {
      const r = await fetch(`${base}/voices?userId=${encodeURIComponent(USER_ID)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.voices = (await r.json()) as VoiceProfile[];
      this.render();
    } catch (err) {
      this.voices = [];
      this.renderMessage('Failed to load cloned voices — see Console.');
      this.app.log(`voice-manager: list failed — ${String(err)}`);
    }
  }

  private async del(id: string): Promise<void> {
    const base = apiBase();
    try {
      const r = await fetch(`${base}/voices/${encodeURIComponent(id)}?userId=${encodeURIComponent(USER_ID)}`, {
        method: 'DELETE',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { deletedObjects?: number };
      this.app.log(`voice-manager: deleted voice ${id} (${body.deletedObjects ?? 0} R2 object(s)).`);
      await this.refresh();
    } catch (err) {
      this.confirmingId = null;
      this.render();
      this.app.log(`voice-manager: delete ${id} failed — ${String(err)}`);
    }
  }

  private async retry(id: string): Promise<void> {
    const base = apiBase();
    try {
      const r = await fetch(`${base}/voices/${encodeURIComponent(id)}/retry?userId=${encodeURIComponent(USER_ID)}`, {
        method: 'POST',
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}${detail ? ` — ${detail}` : ''}`);
      }
      this.app.log(`voice-manager: re-enqueued clone ${id}.`);
      await this.refresh();
    } catch (err) {
      this.app.log(`voice-manager: retry ${id} failed — ${String(err)}`);
    }
  }

  private renderMessage(msg: string): void {
    const list = this.app.dom.voiceMgrListEl;
    list.replaceChildren();
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = msg;
    list.appendChild(p);
  }

  private render(): void {
    const list = this.app.dom.voiceMgrListEl;
    if (this.voices.length === 0) {
      this.renderMessage('No cloned voices yet.');
      return;
    }
    list.replaceChildren();
    for (const v of this.voices) list.appendChild(this.renderRow(v));
  }

  private button(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  private renderRow(v: VoiceProfile): HTMLElement {
    const row = document.createElement('div');
    row.className = 'voice-row';

    const main = document.createElement('div');
    main.className = 'voice-row-main';
    const label = document.createElement('span');
    label.className = 'voice-row-label';
    label.textContent = v.label || '(untitled)';
    const badge = document.createElement('span');
    const b = statusBadge(v.status);
    badge.className = `badge ${b.cls}`;
    badge.textContent = b.label;
    main.append(label, badge);

    const meta = document.createElement('div');
    meta.className = 'voice-row-meta';
    const created = formatCreated(v.createdAt);
    meta.textContent = [v.engine, created].filter(Boolean).join(' · ');

    const actions = document.createElement('div');
    actions.className = 'voice-row-actions';
    if (this.confirmingId === v.id) {
      // Inline confirm (no blocking modal): the Delete button became Confirm/Cancel.
      actions.append(
        this.button('Confirm delete', 'voice-btn danger', () => void this.del(v.id)),
        this.button('Cancel', 'voice-btn', () => {
          this.confirmingId = null;
          this.render();
        }),
      );
    } else {
      if (retryEligible(v.status)) {
        actions.appendChild(this.button('↻ Retry', 'voice-btn', () => void this.retry(v.id)));
      }
      actions.appendChild(
        this.button('Delete', 'voice-btn danger', () => {
          this.confirmingId = v.id;
          this.render();
        }),
      );
    }

    row.append(main, meta, actions);
    return row;
  }
}
