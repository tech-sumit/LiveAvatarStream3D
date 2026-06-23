// Non-invasive decorator: append a live numeric readout to every range slider in the
// left/right sidebars without touching the existing slider markup. Each readout is a
// tiny <span class="slider-value"> that updates on `input`. Integer-step sliders show
// no decimals, fractional-step ones show 2; Rate/Pitch (#rate/#pitch) get an "x" unit.

/** Sliders that represent a multiplier and should display an "x" suffix. */
const MULTIPLIER_IDS = new Set(['rate', 'pitch']);

function format(input: HTMLInputElement): string {
  const value = Number(input.value);
  const step = Number(input.step);
  // An integer step (or no step) → whole numbers; otherwise 2 decimals.
  const isInteger = !input.step || Number.isInteger(step);
  const text = isInteger ? String(Math.round(value)) : value.toFixed(2);
  return MULTIPLIER_IDS.has(input.id) ? `${text}x` : text;
}

/**
 * Find every `input[type='range']` inside a `.panel` and append a live value readout
 * to it. Idempotent: a slider already decorated is skipped.
 */
export function initSliderReadouts(): void {
  const sliders = document.querySelectorAll<HTMLInputElement>(".panel input[type='range']");
  for (const slider of sliders) {
    // Skip if already decorated (the readout is the slider's immediate next sibling).
    if (slider.nextElementSibling?.classList.contains('slider-value')) continue;
    const out = document.createElement('span');
    out.className = 'slider-value';
    out.textContent = format(slider);
    slider.insertAdjacentElement('afterend', out);
    slider.addEventListener('input', () => {
      out.textContent = format(slider);
    });
  }
}
