import { CATALOG } from './catalog.js';
import { cueId, type Cue, type Timeline, type TrackKind } from './types.js';

// A from-scratch, video-editor-style timeline panel (vanilla DOM). Lanes per
// track, draggable + resizable cue blocks (pointer capture, snap to 0.1s), a
// ruler, a playhead, and Add menus driven by the cue CATALOG. Emits changes so
// the host can re-run the director.
export interface TimelineUIHooks {
  onChange(): void;
  onPreview(): void;
  onStop(): void;
  onSeek(t: number): void;
  onCapturePose(): void; // add a Custom-view camera cue from the live camera
  onRecordPath(): void; // toggle recording a free camera move
  onSelect?(cue: Cue | null): void; // a cue was selected/deselected (for the inspector)
  onGenerate?(): void; // (re)generate narration from the script
  onAddAudio?(): void; // add a background-audio clip
}

const LANES: { kind: TrackKind; name: string }[] = [
  { kind: 'narration', name: 'Narration' },
  { kind: 'camera', name: 'Camera' },
  { kind: 'motion', name: 'Motion' },
  { kind: 'audio', name: 'Audio' },
];
const LABEL_W = 78;
const LANE_H = 40;
const RULER_H = 18;
const MIN_TICK_PX = 60; // aim for ~60px between ruler labels

export class TimelineUI {
  private root: HTMLElement;
  private trackArea!: HTMLElement;
  private playheadEl!: HTMLElement;
  private snapGuideEl!: HTMLElement;
  private timeLabel!: HTMLElement;
  private selected: string | null = null;
  private pxPerSec = 60;
  private basePxPerSec = 60; // auto-fit baseline before zoom is applied
  private zoom = 1;
  private playheadT = 0;
  private playing = false;
  private addMenuEl: HTMLElement | null = null;
  private undoStack: string[] = []; // serialized timeline snapshots (last ~5)

  constructor(
    container: HTMLElement,
    private timeline: Timeline,
    private hooks: TimelineUIHooks,
  ) {
    this.root = container;
    this.build();
    window.addEventListener('resize', () => this.layout());
    window.addEventListener('keydown', this.onKeyDown);
  }

  getTimeline(): Timeline {
    return this.timeline;
  }

  setPlaying(on: boolean): void {
    this.playing = on;
    this.root.querySelector('#tlPlay')!.textContent = on ? '■ Stop' : '▶ Preview';
  }

  setRecording(on: boolean): void {
    const b = this.root.querySelector('#tlRec') as HTMLElement | null;
    if (b) {
      b.textContent = on ? '■ Stop rec' : '● Rec cam';
      b.classList.toggle('tl-recording', on);
    }
  }

  /** Re-render after the host adds a cue (capture / recorded path). */
  refresh(): void {
    this.render();
  }

  /** Rebuild from scratch after the timeline is replaced (load / new). */
  reload(): void {
    this.selected = null;
    this.undoStack = []; // a new timeline → drop stale undo history
    this.build();
    this.hooks.onSelect?.(null);
  }

  setPlayhead(t: number): void {
    this.playheadT = t;
    const x = LABEL_W + t * this.pxPerSec;
    this.playheadEl.style.left = `${x}px`;
    this.timeLabel.textContent = `${t.toFixed(1)}s`;
  }

  private build(): void {
    this.root.innerHTML = '';
    this.root.classList.add('tl');
    this.closeAddMenu();

    // Toolbar
    const bar = el('div', 'tl-bar');
    const play = el('button', 'tl-btn');
    play.id = 'tlPlay';
    play.textContent = '▶ Preview';
    play.onclick = () => this.hooks.onPreview();
    this.timeLabel = el('span', 'tl-time');
    this.timeLabel.textContent = '0.0s';

    const gen = el('button', 'tl-btn');
    gen.id = 'tlGen';
    gen.textContent = '🎙 Generate';
    gen.title = 'Synthesize the script → narration lane (then Preview plays it lip-synced)';
    gen.onclick = () => this.hooks.onGenerate?.();

    const add = el('button', 'tl-btn') as HTMLButtonElement;
    add.id = 'tlAdd';
    add.textContent = '＋ Add';
    add.title = 'Add a Camera or Motion cue';
    add.onclick = (e) => {
      e.stopPropagation();
      this.openAddMenu();
    };

    const addAudio = el('button', 'tl-btn');
    addAudio.textContent = '+ Audio';
    addAudio.title = 'Add a background-music / SFX clip';
    addAudio.onclick = () => this.hooks.onAddAudio?.();

    const capture = el('button', 'tl-btn');
    capture.textContent = '⌖ Capture';
    capture.title = 'Add a camera cue from the current view';
    capture.onclick = () => this.hooks.onCapturePose();

    const rec = el('button', 'tl-btn');
    rec.id = 'tlRec';
    rec.textContent = '● Rec cam';
    rec.title = 'Record a free camera move (orbit / arrow keys), then Stop';
    rec.onclick = () => this.hooks.onRecordPath();

    // Zoom: a compact stepper (🔍 − %  +) that multiplies the auto-fit baseline
    // pxPerSec in 10% steps over 50%–200%. Replaces the wide range slider.
    const zoomGroup = el('div', 'tl-zoomctl');
    const zoomIcon = el('span', 'tl-zoom-ic');
    zoomIcon.textContent = '🔍';
    zoomIcon.title = 'Timeline zoom';
    const zoomMinus = el('button', 'tl-btn tl-zoom-btn') as HTMLButtonElement;
    zoomMinus.textContent = '−';
    zoomMinus.title = 'Zoom out';
    const zoomPct = el('span', 'tl-zoom-pct');
    const zoomPlus = el('button', 'tl-btn tl-zoom-btn') as HTMLButtonElement;
    zoomPlus.textContent = '+';
    zoomPlus.title = 'Zoom in';
    const ZOOM_MIN = 0.5;
    const ZOOM_MAX = 2;
    const ZOOM_STEP = 0.1;
    const renderZoomPct = () => {
      zoomPct.textContent = `${Math.round(this.zoom * 100)}%`;
      zoomMinus.disabled = this.zoom <= ZOOM_MIN + 1e-6;
      zoomPlus.disabled = this.zoom >= ZOOM_MAX - 1e-6;
    };
    const stepZoom = (dir: number) => {
      const next = Math.round((this.zoom + dir * ZOOM_STEP) * 10) / 10;
      this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
      renderZoomPct();
      this.layout();
    };
    zoomMinus.onclick = () => stepZoom(-1);
    zoomPlus.onclick = () => stepZoom(1);
    renderZoomPct();
    zoomGroup.append(zoomIcon, zoomMinus, zoomPct, zoomPlus);

    const durLabel = el('span', 'tl-dim');
    durLabel.textContent = 'Length';
    const dur = el('input', 'tl-num') as HTMLInputElement;
    dur.type = 'number';
    dur.min = '2';
    dur.step = '1';
    dur.value = String(this.timeline.duration);
    dur.oninput = () => {
      this.timeline.duration = Math.max(2, Number(dur.value) || 2);
      this.layout();
      this.hooks.onChange();
    };

    const undo = el('button', 'tl-btn') as HTMLButtonElement;
    undo.id = 'tlUndo';
    undo.textContent = '↶ Undo';
    undo.title = 'Undo the last cue change';
    undo.disabled = this.undoStack.length === 0;
    undo.onclick = () => this.undo();

    const clear = el('button', 'tl-btn');
    clear.textContent = 'Clear';
    clear.title = 'Remove all cues';
    clear.onclick = () => {
      if (!this.timeline.cues.length) return;
      if (!confirm(`Clear all ${this.timeline.cues.length} cue(s)? This cannot be undone except via Undo.`)) return;
      this.pushUndo();
      this.timeline.cues = [];
      this.selected = null;
      this.hooks.onSelect?.(null);
      this.render();
      this.hooks.onChange();
    };

    bar.append(
      play,
      this.timeLabel,
      sep(),
      gen,
      sep(),
      add,
      addAudio,
      capture,
      rec,
      sep(),
      zoomGroup,
      sep(),
      durLabel,
      dur,
      sep(),
      undo,
      clear,
    );

    // Body: fixed labels + scrollable track area
    const body = el('div', 'tl-body');
    const labels = el('div', 'tl-labels');
    const ru = el('div', 'tl-lane-label');
    ru.textContent = '';
    ru.style.height = `${RULER_H}px`;
    labels.append(ru);
    for (const l of LANES) {
      const lab = el('div', 'tl-lane-label');
      lab.dataset.kind = l.kind;
      lab.dataset.name = l.name;
      lab.textContent = l.name;
      lab.style.height = `${LANE_H}px`;
      labels.append(lab);
    }
    this.trackArea = el('div', 'tl-tracks');
    this.playheadEl = el('div', 'tl-playhead');
    const grab = el('div', 'tl-playhead-grab');
    this.playheadEl.append(grab);
    this.snapGuideEl = el('div', 'tl-snap-guide');
    this.snapGuideEl.hidden = true;
    this.trackArea.append(this.snapGuideEl, this.playheadEl);
    this.wirePlayheadDrag();
    // seek by clicking the ruler/track area
    this.trackArea.addEventListener('pointerdown', (e) => {
      if (e.target !== this.trackArea && !(e.target as HTMLElement).classList.contains('tl-ruler')) return;
      const rect = this.trackArea.getBoundingClientRect();
      const t = Math.max(0, (e.clientX - rect.left - LABEL_W + this.trackArea.scrollLeft) / this.pxPerSec);
      this.hooks.onSeek(t);
    });

    body.append(labels, this.trackArea);
    this.root.append(bar, body);
    this.render();
  }

  // ── Add-cue modal dialog ──────────────────────────────────────────────────

  /**
   * Open the "Add a cue" modal: a grid of element cards grouped Camera/Motion.
   * Click a card → add that cue and close. `focusTrack` scrolls to a group
   * (used by the C / M keyboard shortcuts). `anchor` is accepted but unused now
   * that this is a centered dialog rather than an anchored popover.
   */
  openAddMenu(_anchor?: HTMLElement, focusTrack?: 'camera' | 'motion'): void {
    this.closeAddMenu();

    const backdrop = el('div', 'tl-modal');
    const panel = el('div', 'tl-modal-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');

    const header = el('div', 'tl-modal-head');
    const title = el('h3', 'tl-modal-title');
    title.textContent = 'Add a cue';
    const close = el('button', 'tl-modal-close') as HTMLButtonElement;
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'Close';
    close.onclick = () => this.closeAddMenu();
    header.append(title, close);
    panel.append(header);

    const bodyEl = el('div', 'tl-modal-body');
    const groups: { kind: TrackKind; name: string }[] = [
      { kind: 'camera', name: 'Camera' },
      { kind: 'motion', name: 'Motion' },
    ];
    for (const g of groups) {
      const section = el('div', 'tl-modal-section');
      section.dataset.track = g.kind;
      const head = el('div', 'tl-modal-subhead');
      head.textContent = g.name;
      section.append(head);
      const grid = el('div', 'tl-modal-grid');
      for (const [key, d] of Object.entries(CATALOG)) {
        if (d.track !== g.kind) continue;
        const card = el('button', 'tl-card') as HTMLButtonElement;
        card.type = 'button';
        card.style.setProperty('--card-accent', d.color);
        const icon = el('span', 'tl-card-icon');
        icon.textContent = d.icon;
        const name = el('span', 'tl-card-label');
        name.textContent = d.label;
        const desc = el('span', 'tl-card-desc');
        desc.textContent = d.desc;
        card.append(icon, name, desc);
        card.onclick = () => {
          this.add(key);
          this.closeAddMenu();
        };
        grid.append(card);
      }
      section.append(grid);
      bodyEl.append(section);
    }
    panel.append(bodyEl);
    backdrop.append(panel);

    // backdrop click (but not clicks inside the panel) closes the dialog
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) this.closeAddMenu();
    });

    document.body.append(backdrop);
    this.addMenuEl = backdrop;
    window.addEventListener('keydown', this.onAddMenuKey, true);

    if (focusTrack) {
      const section = panel.querySelector(`.tl-modal-section[data-track="${focusTrack}"]`) as HTMLElement | null;
      section?.scrollIntoView({ block: 'nearest' });
    }
  }

  private onAddMenuKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.closeAddMenu();
    }
  };

  private closeAddMenu(): void {
    if (this.addMenuEl) {
      this.addMenuEl.remove();
      this.addMenuEl = null;
    }
    window.removeEventListener('keydown', this.onAddMenuKey, true);
  }

  private add(type: string): void {
    const d = CATALOG[type];
    if (!d) return;
    this.pushUndo();
    const at = Number(this.timeLabel.textContent?.replace('s', '')) || 0;
    this.timeline.cues.push({ id: cueId(), track: d.track, type, start: at, duration: d.defaultDuration });
    this.render();
    this.hooks.onChange();
  }

  private remove(id: string): void {
    this.pushUndo();
    this.timeline.cues = this.timeline.cues.filter((c) => c.id !== id);
    if (this.selected === id) {
      this.selected = null;
      this.hooks.onSelect?.(null);
    }
    this.render();
    this.hooks.onChange();
  }

  /** Remove a cue programmatically (e.g. from the inspector's Delete button). */
  removeCue(id: string): void {
    this.remove(id);
  }

  // ── Undo stack (last ~5 timeline states) ──────────────────────────────────

  private snapshot(): string {
    return JSON.stringify(this.timeline.cues);
  }
  private pushUndo(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 5) this.undoStack.shift();
    this.refreshUndoBtn();
  }
  private refreshUndoBtn(): void {
    const b = this.root.querySelector('#tlUndo') as HTMLButtonElement | null;
    if (b) b.disabled = this.undoStack.length === 0;
  }
  private undo(): void {
    const prev = this.undoStack.pop();
    if (prev == null) return;
    try {
      this.timeline.cues = JSON.parse(prev) as Cue[];
    } catch {
      return;
    }
    if (this.selected && !this.timeline.cues.some((c) => c.id === this.selected)) {
      this.selected = null;
      this.hooks.onSelect?.(null);
    }
    this.render();
    this.refreshUndoBtn();
    this.hooks.onChange();
  }

  // ── Playhead drag-scrub + snap guide ──────────────────────────────────────

  private wirePlayheadDrag(): void {
    this.playheadEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.playheadEl.setPointerCapture(e.pointerId);
      this.playheadEl.classList.add('dragging');
      const rect = this.trackArea.getBoundingClientRect();
      const seekAt = (clientX: number) => {
        const t = (clientX - rect.left - LABEL_W + this.trackArea.scrollLeft) / this.pxPerSec;
        const clamped = Math.max(0, Math.min(this.timeline.duration, t));
        this.hooks.onSeek(clamped);
        this.setPlayhead(clamped);
      };
      seekAt(e.clientX);
      const move = (ev: PointerEvent) => seekAt(ev.clientX);
      const up = (ev: PointerEvent) => {
        this.playheadEl.releasePointerCapture(ev.pointerId);
        this.playheadEl.classList.remove('dragging');
        this.playheadEl.removeEventListener('pointermove', move);
        this.playheadEl.removeEventListener('pointerup', up);
      };
      this.playheadEl.addEventListener('pointermove', move);
      this.playheadEl.addEventListener('pointerup', up);
    });
  }

  private showSnapGuide(t: number): void {
    this.snapGuideEl.hidden = false;
    this.snapGuideEl.style.left = `${LABEL_W + t * this.pxPerSec}px`;
  }
  private hideSnapGuide(): void {
    this.snapGuideEl.hidden = true;
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  private onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    const typing =
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selected && !typing) {
        e.preventDefault();
        this.remove(this.selected);
      }
      return;
    }
    if (typing) return;
    // Dock-scoped: this window listener lives for the page lifetime (registered once in the
    // constructor), so gate every shortcut on the timeline dock actually being OPEN —
    // Space/C/M used to keep firing (and steal keys from walk mode) after the panel closed.
    if (!this.root.closest('.tl-open')) return;
    // Only the timeline-area shortcuts below; guarded so they don't steal input focus.
    switch (e.key) {
      case ' ': // Space → toggle preview
        e.preventDefault();
        this.hooks.onPreview();
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        // Only consume arrows when a cue is selected (nudge it) or while previewing
        // (scrub). Otherwise defer to the host's camera-navigation arrow handler.
        const cue = this.selected ? this.timeline.cues.find((c) => c.id === this.selected && c.track !== 'narration') : null;
        if (!cue && !this.playing) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const dt = e.shiftKey ? 1 : 0.1;
        this.nudge(e.key === 'ArrowLeft' ? -dt : dt);
        break;
      }
      case 'a':
      case 'A':
        e.preventDefault();
        this.hooks.onAddAudio?.();
        break;
      case 'c':
      case 'C':
        e.preventDefault();
        this.openAddMenu(undefined, 'camera');
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        this.openAddMenu(undefined, 'motion');
        break;
      default:
        break;
    }
  };

  /** Nudge the selected (editable) cue by dt, else scrub the playhead by dt. */
  private nudge(dt: number): void {
    const cue = this.selected ? this.timeline.cues.find((c) => c.id === this.selected) : null;
    if (cue && cue.track !== 'narration') {
      cue.start = Math.max(0, Math.round((cue.start + dt) * 10) / 10);
      this.render();
      this.hooks.onChange();
      return;
    }
    const t = Math.max(0, Math.min(this.timeline.duration, Math.round((this.playheadT + dt) * 10) / 10));
    this.hooks.onSeek(t);
    this.setPlayhead(t);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private render(): void {
    // wipe lanes (keep playhead + snap guide)
    this.trackArea.querySelectorAll('.tl-lane, .tl-ruler').forEach((n) => n.remove());

    const ruler = el('div', 'tl-ruler');
    ruler.style.left = `${LABEL_W}px`;
    this.trackArea.append(ruler);

    LANES.forEach((lane, i) => {
      const laneEl = el('div', 'tl-lane');
      laneEl.style.left = `${LABEL_W}px`;
      laneEl.style.top = `${RULER_H + i * LANE_H}px`;
      laneEl.style.height = `${LANE_H}px`;
      laneEl.dataset.kind = lane.kind;
      for (const cue of this.timeline.cues.filter((c) => c.track === lane.kind)) {
        laneEl.append(this.cueEl(cue));
      }
      this.trackArea.append(laneEl);
    });
    this.updateLaneCounts();
    this.layout();
  }

  /** Refresh lane labels to "Name (n)" cue counts. */
  private updateLaneCounts(): void {
    const labels = this.root.querySelectorAll('.tl-lane-label[data-kind]');
    labels.forEach((node) => {
      const lab = node as HTMLElement;
      const kind = lab.dataset.kind as TrackKind;
      const name = lab.dataset.name ?? '';
      const n = this.timeline.cues.filter((c) => c.track === kind).length;
      lab.textContent = `${name} (${n})`;
    });
  }

  private cueEl(cue: Cue): HTMLElement {
    const d = CATALOG[cue.type];
    const c = el('div', 'tl-cue');
    const label = cue.track === 'narration' ? (cue.text ?? '…') : cue.track === 'audio' ? (cue.label ?? 'audio') : d ? d.label : cue.type;
    c.style.background = cue.track === 'narration' ? '#445170' : cue.track === 'audio' ? '#c78b3a' : d ? d.color : '#666';
    c.textContent = label;
    c.title = label; // full label on hover (CSS ellipsis-truncates the visible text)
    if (cue.id === this.selected) c.classList.add('sel');

    // Narration blocks are read-only (timing is owned by the synthesized audio) —
    // clickable to inspect, but not draggable/resizable.
    if (cue.track === 'narration') {
      c.classList.add('readonly');
      c.style.cursor = 'pointer';
      c.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.select(cue.id);
      });
      this.placeCue(c, cue);
      return c;
    }

    const handle = el('div', 'tl-handle');
    c.append(handle);

    // move
    c.addEventListener('pointerdown', (e) => {
      if (e.target === handle) return;
      e.stopPropagation();
      c.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startT = cue.start;
      let moved = false;
      const move = (ev: PointerEvent) => {
        const dt = (ev.clientX - startX) / this.pxPerSec;
        if (Math.abs(ev.clientX - startX) > 3) moved = true;
        cue.start = Math.max(0, Math.round((startT + dt) * 10) / 10);
        this.placeCue(c, cue);
        if (moved) this.showSnapGuide(cue.start);
      };
      const up = (ev: PointerEvent) => {
        c.releasePointerCapture(ev.pointerId);
        c.removeEventListener('pointermove', move);
        c.removeEventListener('pointerup', up);
        this.hideSnapGuide();
        if (moved) this.pushUndo();
        this.select(cue.id);
        if (moved) this.hooks.onChange();
      };
      c.addEventListener('pointermove', move);
      c.addEventListener('pointerup', up);
    });

    // resize
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startD = cue.duration;
      let resized = false;
      const move = (ev: PointerEvent) => {
        const dd = (ev.clientX - startX) / this.pxPerSec;
        if (Math.abs(ev.clientX - startX) > 3) resized = true;
        cue.duration = Math.max(0.3, Math.round((startD + dd) * 10) / 10);
        this.placeCue(c, cue);
        if (resized) this.showSnapGuide(cue.start + cue.duration);
      };
      const up = (ev: PointerEvent) => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        this.hideSnapGuide();
        if (resized) this.pushUndo();
        this.hooks.onChange();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });

    this.placeCue(c, cue);
    return c;
  }

  private select(id: string): void {
    this.selected = id;
    this.trackArea.querySelectorAll('.tl-cue').forEach((n) => n.classList.remove('sel'));
    this.render();
    this.hooks.onSelect?.(this.timeline.cues.find((c) => c.id === id) ?? null);
  }

  private placeCue(c: HTMLElement, cue: Cue): void {
    c.style.left = `${cue.start * this.pxPerSec}px`;
    c.style.width = `${Math.max(8, cue.duration * this.pxPerSec)}px`;
  }

  private layout(): void {
    const avail = this.trackArea.clientWidth - LABEL_W - 8;
    this.basePxPerSec = Math.max(24, avail / Math.max(2, this.timeline.duration));
    this.pxPerSec = this.basePxPerSec * this.zoom;
    // ruler ticks: adaptive spacing so labels never jam at low zoom (~60px apart)
    const ruler = this.trackArea.querySelector('.tl-ruler') as HTMLElement | null;
    if (ruler) {
      ruler.innerHTML = '';
      const step = this.tickStep();
      for (let s = 0; s <= this.timeline.duration + 1e-6; s += step) {
        const tick = el('span', 'tl-tick');
        tick.style.left = `${s * this.pxPerSec}px`;
        tick.textContent = `${Number(s.toFixed(1))}s`;
        ruler.append(tick);
      }
    }
    for (const laneEl of Array.from(this.trackArea.querySelectorAll('.tl-lane')) as HTMLElement[]) {
      const kind = laneEl.dataset.kind as TrackKind;
      const cues = this.timeline.cues.filter((c) => c.track === kind);
      const els = Array.from(laneEl.querySelectorAll('.tl-cue')) as HTMLElement[];
      els.forEach((c, i) => cues[i] && this.placeCue(c, cues[i]));
    }
    // keep the playhead aligned to its current time after a zoom/relayout
    this.playheadEl.style.left = `${LABEL_W + this.playheadT * this.pxPerSec}px`;
  }

  /** Pick a "nice" tick step (1/2/5/10…) so labels sit ~MIN_TICK_PX apart. */
  private tickStep(): number {
    const targetSec = MIN_TICK_PX / this.pxPerSec; // seconds we'd want per label
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60];
    for (const s of steps) if (s >= targetSec) return s;
    return steps[steps.length - 1];
  }
}

function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function sep(): HTMLElement {
  return el('span', 'tl-sep');
}
