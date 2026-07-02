// Floating viewport quick-access widget + on-canvas affordances for #stage.
//
// This module is ADDITIVE: every button here mirrors an existing right-panel
// control and drives the SAME code path rather than re-implementing camera logic:
//   • Close / Medium / Wide → set #shot's value + dispatch its `change`
//     (the AvatarTransform `change` handler applies the shared shot-preset catalog).
//   • ⟲ Reset cam          → click #resetView   (AvatarTransform handler).
//   • ⊕ Align              → click #alignFace    (AvatarTransform handler).
// It also owns three small viewport conveniences that have no sidebar twin:
//   • the gizmo-off discoverability hint (CSS-driven by the `.gizmo-on` class
//     AvatarTransform toggles on #stage — we only inject the element),
//   • the dismissible #viewHint (close ✕ / H / first canvas pointerdown,
//     persisted in sessionStorage),
//   • the OUTPUT PiP show/hide toggle (persisted in localStorage),
//   • the first-load welcome overlay (persisted in localStorage).
import type { Dom } from './dom.js';

const VIEWHINT_DISMISSED = 'las.viewHint.dismissed';
const PIP_HIDDEN = 'las.pip.hidden';

/** Build the top-of-stage quick-access pill that mirrors the sidebar camera controls. */
function buildQuickAccess(dom: Dom): void {
  const bar = document.createElement('div');
  bar.id = 'camQuick';
  bar.className = 'cam-quick';

  // Shot group — drive the existing #shot select so the SAME framing runs.
  const setShot = (shot: 'close' | 'medium' | 'wide'): void => {
    dom.shotSel.value = shot;
    dom.shotSel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const shots: Array<['close' | 'medium' | 'wide', string, string]> = [
    ['close', 'Close', 'Close-up shot'],
    ['medium', 'Medium', 'Medium shot'],
    ['wide', 'Wide', 'Wide shot'],
  ];
  const shotBtns = shots.map(([value, label, title]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cam-quick-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', () => setShot(value));
    bar.appendChild(b);
    return { value, b };
  });
  // Reflect the current #shot value as the active pill (and keep it in sync).
  const syncActive = (): void => {
    for (const { value, b } of shotBtns) b.classList.toggle('on', dom.shotSel.value === value);
  };
  dom.shotSel.addEventListener('change', syncActive);
  // The gizmo toggle forces #shot to "wide" by setting .value directly (no `change`
  // event), so also re-sync whenever #stage's gizmo class flips.
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(syncActive).observe(dom.stageEl, { attributes: true, attributeFilter: ['class'] });
  }
  syncActive();

  const sep = document.createElement('span');
  sep.className = 'cam-quick-sep';
  bar.appendChild(sep);

  // Reset / Align — reuse the existing buttons' click handlers verbatim.
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'cam-quick-btn';
  reset.innerHTML = '⟲';
  reset.title = 'Reset camera to the current shot';
  reset.setAttribute('aria-label', 'Reset camera');
  reset.addEventListener('click', () => dom.resetViewBtn.click());
  bar.appendChild(reset);

  const align = document.createElement('button');
  align.type = 'button';
  align.className = 'cam-quick-btn';
  align.innerHTML = '⊕';
  align.title = 'Align camera to the face';
  align.setAttribute('aria-label', 'Align to face');
  align.addEventListener('click', () => dom.alignFaceBtn.click());
  bar.appendChild(align);

  dom.stageEl.appendChild(bar);
}

/** Inject the faint, non-interactive "Press G to edit" hint (shown only when the
 *  gizmo is OFF — CSS keys off the `.gizmo-on` class AvatarTransform sets). */
function buildGizmoHint(dom: Dom): void {
  const hint = document.createElement('div');
  hint.id = 'gizmoHint';
  hint.className = 'gizmo-hint';
  hint.textContent = 'Press G or ✥ Edit avatar in 3D';
  dom.stageEl.appendChild(hint);
}

/** Add a close ✕ to #viewHint; dismiss on click / H / first canvas pointerdown,
 *  remembered for the session. */
function wireViewHintDismiss(dom: Dom): void {
  const hint = dom.viewHintEl;
  if (!hint) return;

  const dismiss = (): void => {
    if (hint.hidden) return;
    hint.hidden = true;
    try {
      sessionStorage.setItem(VIEWHINT_DISMISSED, '1');
    } catch {
      /* private mode — fine, hint just won't persist */
    }
  };

  if (sessionStorage.getItem(VIEWHINT_DISMISSED) === '1') {
    hint.hidden = true;
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'view-hint-close';
  close.textContent = '✕';
  close.title = 'Dismiss this hint (H)';
  close.setAttribute('aria-label', 'Dismiss view hint');
  close.addEventListener('click', dismiss);
  hint.appendChild(close);

  // Auto-hide on the first OrbitControls interaction (pointerdown on the canvas).
  dom.stageEl.addEventListener('pointerdown', (e) => {
    if (e.target instanceof HTMLCanvasElement) dismiss();
  });

  // H dismisses too (ignore while typing).
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'h' || e.key === 'H') dismiss();
  });
}

/** OUTPUT PiP show/hide toggle (eye), persisted in localStorage. The `.rec` recording
 *  state is owned elsewhere and untouched. */
function wirePipToggle(dom: Dom): void {
  const pip = dom.pipFrameEl;
  if (!pip) return;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'pip-toggle';

  const apply = (hidden: boolean): void => {
    pip.classList.toggle('pip-collapsed', hidden);
    toggle.textContent = hidden ? '🙈' : '✕';
    toggle.title = hidden ? 'Show the OUTPUT monitor' : 'Hide the OUTPUT monitor';
    toggle.setAttribute('aria-label', hidden ? 'Show output monitor' : 'Hide output monitor');
  };

  let hidden = false;
  try {
    hidden = localStorage.getItem(PIP_HIDDEN) === '1';
  } catch {
    /* private mode */
  }
  apply(hidden);

  toggle.addEventListener('click', () => {
    hidden = !hidden;
    apply(hidden);
    try {
      localStorage.setItem(PIP_HIDDEN, hidden ? '1' : '0');
    } catch {
      /* private mode */
    }
  });

  // The #pipFrame itself is pointer-events:none; the toggle re-enables pointers on itself.
  pip.appendChild(toggle);
}

/** Wire all viewport quick-access affordances. Call once from main.ts after the DOM exists. */
export function initCameraQuickAccess(dom: Dom): void {
  buildGizmoHint(dom);
  buildQuickAccess(dom);
  wireViewHintDismiss(dom);
  wirePipToggle(dom);
}
