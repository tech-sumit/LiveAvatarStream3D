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
}

const LANES: { kind: TrackKind; name: string }[] = [
  { kind: 'camera', name: 'Camera' },
  { kind: 'motion', name: 'Motion' },
];
const LABEL_W = 78;
const LANE_H = 40;

export class TimelineUI {
  private root: HTMLElement;
  private trackArea!: HTMLElement;
  private playheadEl!: HTMLElement;
  private timeLabel!: HTMLElement;
  private selected: string | null = null;
  private pxPerSec = 60;

  constructor(
    container: HTMLElement,
    private timeline: Timeline,
    private hooks: TimelineUIHooks,
  ) {
    this.root = container;
    this.build();
    window.addEventListener('resize', () => this.layout());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.selected && !(e.target instanceof HTMLInputElement)) {
          this.remove(this.selected);
        }
      }
    });
  }

  getTimeline(): Timeline {
    return this.timeline;
  }

  setPlaying(on: boolean): void {
    this.root.querySelector('#tlPlay')!.textContent = on ? '■ Stop' : '▶ Preview';
  }

  setPlayhead(t: number): void {
    const x = LABEL_W + t * this.pxPerSec;
    this.playheadEl.style.left = `${x}px`;
    this.timeLabel.textContent = `${t.toFixed(1)}s`;
  }

  private build(): void {
    this.root.innerHTML = '';
    this.root.classList.add('tl');

    // Toolbar
    const bar = el('div', 'tl-bar');
    const play = el('button', 'tl-btn');
    play.id = 'tlPlay';
    play.textContent = '▶ Preview';
    play.onclick = () => this.hooks.onPreview();
    this.timeLabel = el('span', 'tl-time');
    this.timeLabel.textContent = '0.0s';

    const addCam = this.addMenu('camera', '+ Camera');
    const addMotion = this.addMenu('motion', '+ Motion');

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

    const clear = el('button', 'tl-btn');
    clear.textContent = 'Clear';
    clear.onclick = () => {
      this.timeline.cues = [];
      this.selected = null;
      this.render();
      this.hooks.onChange();
    };

    bar.append(play, this.timeLabel, sep(), addCam, addMotion, sep(), durLabel, dur, sep(), clear);

    // Body: fixed labels + scrollable track area
    const body = el('div', 'tl-body');
    const labels = el('div', 'tl-labels');
    const ru=el('div','tl-lane-label'); ru.textContent=''; ru.style.height='18px'; labels.append(ru);
    for (const l of LANES) {
      const lab = el('div', 'tl-lane-label');
      lab.textContent = l.name;
      lab.style.height = `${LANE_H}px`;
      labels.append(lab);
    }
    this.trackArea = el('div', 'tl-tracks');
    this.playheadEl = el('div', 'tl-playhead');
    this.trackArea.append(this.playheadEl);
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

  private addMenu(track: TrackKind, label: string): HTMLElement {
    const sel = el('select', 'tl-add') as HTMLSelectElement;
    const def = el('option') as HTMLOptionElement;
    def.value = '';
    def.textContent = label;
    sel.append(def);
    for (const [key, d] of Object.entries(CATALOG)) {
      if (d.track !== track) continue;
      const o = el('option') as HTMLOptionElement;
      o.value = key;
      o.textContent = d.label;
      sel.append(o);
    }
    sel.onchange = () => {
      if (!sel.value) return;
      this.add(sel.value);
      sel.value = '';
    };
    return sel;
  }

  private add(type: string): void {
    const d = CATALOG[type];
    const at = Number(this.timeLabel.textContent?.replace('s', '')) || 0;
    this.timeline.cues.push({ id: cueId(), track: d.track, type, start: at, duration: d.defaultDuration });
    this.render();
    this.hooks.onChange();
  }

  private remove(id: string): void {
    this.timeline.cues = this.timeline.cues.filter((c) => c.id !== id);
    if (this.selected === id) this.selected = null;
    this.render();
    this.hooks.onChange();
  }

  private render(): void {
    // wipe lanes (keep playhead)
    this.trackArea.querySelectorAll('.tl-lane, .tl-ruler').forEach((n) => n.remove());

    const ruler = el('div', 'tl-ruler');
    ruler.style.left = `${LABEL_W}px`;
    this.trackArea.append(ruler);

    for (const lane of LANES) {
      const laneEl = el('div', 'tl-lane');
      laneEl.style.left = `${LABEL_W}px`;
      laneEl.style.height = `${LANE_H}px`;
      laneEl.dataset.kind = lane.kind;
      for (const cue of this.timeline.cues.filter((c) => c.track === lane.kind)) {
        laneEl.append(this.cueEl(cue));
      }
      this.trackArea.append(laneEl);
    }
    this.layout();
  }

  private cueEl(cue: Cue): HTMLElement {
    const d = CATALOG[cue.type];
    const c = el('div', 'tl-cue');
    c.style.background = d ? d.color : '#666';
    c.textContent = d ? d.label : cue.type;
    if (cue.id === this.selected) c.classList.add('sel');

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
      };
      const up = (ev: PointerEvent) => {
        c.releasePointerCapture(ev.pointerId);
        c.removeEventListener('pointermove', move);
        c.removeEventListener('pointerup', up);
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
      const move = (ev: PointerEvent) => {
        const dd = (ev.clientX - startX) / this.pxPerSec;
        cue.duration = Math.max(0.3, Math.round((startD + dd) * 10) / 10);
        this.placeCue(c, cue);
      };
      const up = (ev: PointerEvent) => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
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
  }

  private placeCue(c: HTMLElement, cue: Cue): void {
    c.style.left = `${cue.start * this.pxPerSec}px`;
    c.style.width = `${Math.max(8, cue.duration * this.pxPerSec)}px`;
  }

  private layout(): void {
    const avail = this.trackArea.clientWidth - LABEL_W - 8;
    this.pxPerSec = Math.max(24, avail / Math.max(2, this.timeline.duration));
    // ruler ticks
    const ruler = this.trackArea.querySelector('.tl-ruler') as HTMLElement | null;
    if (ruler) {
      ruler.innerHTML = '';
      const step = this.pxPerSec < 40 ? 5 : this.pxPerSec < 80 ? 2 : 1;
      for (let s = 0; s <= this.timeline.duration; s += step) {
        const tick = el('span', 'tl-tick');
        tick.style.left = `${s * this.pxPerSec}px`;
        tick.textContent = `${s}s`;
        ruler.append(tick);
      }
    }
    for (const laneEl of Array.from(this.trackArea.querySelectorAll('.tl-lane')) as HTMLElement[]) {
      const kind = laneEl.dataset.kind as TrackKind;
      const cues = this.timeline.cues.filter((c) => c.track === kind);
      const els = Array.from(laneEl.querySelectorAll('.tl-cue')) as HTMLElement[];
      els.forEach((c, i) => cues[i] && this.placeCue(c, cues[i]));
    }
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
