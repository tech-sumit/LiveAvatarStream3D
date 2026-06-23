// Script editor — an overlay-highlight layer over the existing #script textarea.
// The textarea stays the single value source (performer + projectStore read
// dom.scriptEl.value); we only add a colored <pre> behind it, a chip toolbar that
// inserts [tags] at the caret, a validity indicator, and a conservative auto-format.
//
// Vocabularies come straight from the parser's own sets (GESTURE_NAMES /
// EMOTION_NAMES in ../avatar/gestures.ts), so a tag is highlighted "known" iff the
// performer actually acts on it. Tag detection mirrors the parser: case-insensitive,
// trimmed membership; the performer matches /\[([a-z_]+)\]/gi and lowercases.
import { GESTURE_NAMES, EMOTION_NAMES } from '../avatar/gestures.js';

const EMOTION_SET = new Set<string>(EMOTION_NAMES.map((n) => n.toLowerCase()));
const GESTURE_SET = new Set<string>(GESTURE_NAMES.map((n) => n.toLowerCase()));

// Chips offered in the toolbar. We hide the two non-directional gestures (`none`,
// `explain`) — they're parser fallbacks, not stage directions a user would insert —
// but the highlighter still treats them as known so an explicit [explain] isn't red.
const CHIP_GESTURES = GESTURE_NAMES.filter((g) => g !== 'none' && g !== 'explain');
const CHIP_EMOTIONS = [...EMOTION_NAMES];

type TagKind = 'emotion' | 'gesture' | 'unknown';

/** Classify a raw tag inner (text between the brackets) against the real vocab. */
function classify(inner: string): TagKind {
  const name = inner.trim().toLowerCase();
  if (EMOTION_SET.has(name)) return 'emotion';
  if (GESTURE_SET.has(name)) return 'gesture';
  return 'unknown';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Tokenize the whole script: prose is HTML-escaped, every [..] becomes a colored
// span. Trailing newline gets a zero-width space so the <pre> keeps the last line's
// height in sync with the textarea (textarea shows the empty final line; a <pre>
// would otherwise collapse it).
function highlight(value: string): string {
  let html = '';
  let last = 0;
  const re = /\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    html += escapeHtml(value.slice(last, m.index));
    const kind = classify(m[1]);
    html += `<span class="tok tok-${kind}">${escapeHtml(m[0])}</span>`;
    last = re.lastIndex;
  }
  html += escapeHtml(value.slice(last));
  return html + '​';
}

/** Count tags whose name isn't in either vocabulary (drives the validity badge). */
function unknownTags(value: string): { count: number; firstIndex: number; firstLen: number } {
  let count = 0;
  let firstIndex = -1;
  let firstLen = 0;
  const re = /\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    if (classify(m[1]) === 'unknown') {
      count++;
      if (firstIndex < 0) {
        firstIndex = m.index;
        firstLen = m[0].length;
      }
    }
  }
  return { count, firstIndex, firstLen };
}

/**
 * Conservative tidy:
 *  - normalize tags: lowercase the name + strip inner spaces ([ Wave ] → [wave]).
 *  - collapse runs of spaces/tabs (NOT newlines) to one.
 *  - trim trailing spaces per line.
 *  - ensure one space between a tag and a following word, but keep adjacent tags
 *    glued ([warm][wave] stays).
 * Paragraphs/line breaks are never reflowed or merged.
 */
function tidy(value: string): string {
  // 1) normalize each tag's inner text in place.
  let out = value.replace(/\[([^\]]*)\]/g, (_full, inner: string) => `[${String(inner).trim().toLowerCase()}]`);
  // 2) per-line cleanup so newlines are preserved exactly.
  out = out
    .split('\n')
    .map((line) => {
      let l = line.replace(/[ \t]+/g, ' '); // collapse horizontal whitespace
      // a tag immediately followed by a non-tag, non-space char → insert one space.
      l = l.replace(/(\])(?=[^\s\[])/g, '$1 ');
      return l.replace(/[ \t]+$/g, ''); // trim trailing spaces
    })
    .join('\n');
  return out;
}

export class ScriptEditor {
  private hl: HTMLElement;
  private ta: HTMLTextAreaElement;

  constructor(textarea: HTMLTextAreaElement, highlightEl: HTMLElement) {
    this.ta = textarea;
    this.hl = highlightEl;
  }

  private refresh(): void {
    this.hl.innerHTML = highlight(this.ta.value);
    this.syncScroll();
    this.updateValidity();
  }

  private syncScroll(): void {
    this.hl.scrollTop = this.ta.scrollTop;
    this.hl.scrollLeft = this.ta.scrollLeft;
  }

  private validityEl: HTMLButtonElement | null = null;
  private updateValidity(): void {
    if (!this.validityEl) return;
    const { count } = unknownTags(this.ta.value);
    if (count === 0) {
      this.validityEl.textContent = '✓ script valid';
      this.validityEl.className = 'script-valid ok';
    } else {
      this.validityEl.textContent = `⚠ ${count} unknown tag${count === 1 ? '' : 's'}`;
      this.validityEl.className = 'script-valid warn';
    }
  }

  /** Splice [tag] in at the caret, place the caret after it, refocus, fire input. */
  private insertTag(name: string): void {
    const ta = this.ta;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const snippet = `[${name}]`;
    ta.value = ta.value.slice(0, start) + snippet + ta.value.slice(end);
    const caret = start + snippet.length;
    ta.focus();
    ta.setSelectionRange(caret, caret);
    ta.dispatchEvent(new Event('input'));
  }

  private buildChipRow(label: string, names: readonly string[], kind: 'emotion' | 'gesture'): HTMLElement {
    const row = document.createElement('div');
    row.className = 'chip-row';
    const cap = document.createElement('span');
    cap.className = 'chip-cap';
    cap.textContent = label;
    row.appendChild(cap);
    for (const name of names) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `chip chip-${kind}`;
      b.textContent = name;
      b.title = `Insert [${name}] at the cursor`;
      b.addEventListener('click', () => this.insertTag(name));
      row.appendChild(b);
    }
    return row;
  }

  init(): void {
    // Live highlight: re-tokenize on input, keep scroll in lockstep.
    this.ta.addEventListener('input', () => this.refresh());
    this.ta.addEventListener('scroll', () => this.syncScroll());

    // Build the toolbar (chips + validity + format) and insert it after the
    // .script-edit overlay wrapper, before the Speak row.
    const wrap = this.ta.closest('.script-edit');
    const toolbar = document.createElement('div');
    toolbar.className = 'script-toolbar';

    toolbar.appendChild(this.buildChipRow('Emotions', CHIP_EMOTIONS, 'emotion'));
    toolbar.appendChild(this.buildChipRow('Gestures', CHIP_GESTURES, 'gesture'));

    const actions = document.createElement('div');
    actions.className = 'script-actions';

    this.validityEl = document.createElement('button');
    this.validityEl.type = 'button';
    this.validityEl.className = 'script-valid ok';
    this.validityEl.title = 'Jump to the first unknown tag';
    // Clicking the indicator selects the first unknown tag (handy for fixing typos).
    this.validityEl.addEventListener('click', () => {
      const { firstIndex, firstLen } = unknownTags(this.ta.value);
      if (firstIndex < 0) return;
      this.ta.focus();
      this.ta.setSelectionRange(firstIndex, firstIndex + firstLen);
    });
    actions.appendChild(this.validityEl);

    const fmt = document.createElement('button');
    fmt.type = 'button';
    fmt.className = 'script-fmt';
    fmt.textContent = '✦ Tidy';
    fmt.title = 'Auto-format: normalize tags & spacing (keeps your line breaks)';
    fmt.addEventListener('click', () => {
      this.ta.value = tidy(this.ta.value);
      this.ta.dispatchEvent(new Event('input'));
      this.ta.focus();
    });
    actions.appendChild(fmt);
    toolbar.appendChild(actions);

    if (wrap && wrap.parentElement) {
      wrap.parentElement.insertBefore(toolbar, wrap.nextSibling);
    }

    this.refresh();
  }
}

/** Wire the overlay highlighter + toolbar onto the #script textarea / #scriptHL pre. */
export function initScriptEditor(): void {
  const ta = document.getElementById('script') as HTMLTextAreaElement | null;
  const hl = document.getElementById('scriptHL');
  if (!ta || !hl) return;
  new ScriptEditor(ta, hl).init();
}
