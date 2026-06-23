# Avatar-Live UI Improvement Plan

**Date:** 2026-06-23
**Scope:** `apps/avatar-live` — the realtime 3D talking-avatar studio (topbar + left script/voice panel + viewport + right control panel + bottom timeline).

## Vision

A "great" version of this UI reads like a broadcast control room: every control announces its purpose at a glance, every slider shows its value, and keyboard operators never lose track of focus. The dense right panel and timeline stay scannable because advanced controls collapse by default and live numeric feedback replaces guesswork. New presenters can drive the viewport (rotate, frame, edit avatar) with on-canvas affordances instead of hunting the sidebar, and the whole surface is held together by one spacing/radius/badge design system rather than ad-hoc values.

---

## Quick wins (P0/P1, effort S)

Highest value-per-effort. Do these first — mostly CSS and one-line config.

| Title | Area | File(s) | Pri | Eff |
|---|---|---|---|---|
| Global `:focus-visible` ring on all interactive elements | Accessibility | `src/style.css` | P0 | S |
| Improve disabled-button contrast (drop `opacity:0.45`, use `--muted` + dark bg) | Accessibility | `src/style.css` (~L479) | P0 | S |
| `LIP-SYNC` + `LOOK` start collapsed by default | Right panel density | `src/app/collapsible.ts` (L6) | P1 | S |
| Cap Console height + make it collapse by default (stop it eating the script panel) | Left panel | `src/style.css`, `collapsible.ts`, `index.html` | P1 | S |
| Hover state on collapsible section headers (`.panel .grp > h2:hover`) | Visual feedback | `src/style.css` | P1 | S |
| Clarify capture gate: bolder border + `1080p · 1920×1080` label | Viewport | `src/style.css`, `recording.ts` (L57) | P1 | S |
| Active/pressed feedback on toolbar buttons (`.tb-btn:active`) | Toolbar | `src/style.css` | P2→keep with batch | S |
| Playhead grab cursor + larger, bolder time label + drag hit-zone | Timeline | `src/style.css`, `timeline/ui.ts` | P1 | S |
| Export Format/Codec selects: add visible labels above | Right panel | `index.html` (L81–87) | P1 | S |

> Note: `:focus-visible` appears twice in the audit (toolbar-only S item + a P0 global item). **Merged into one global rule** covering `button, input, select, .filebtn, .tb-btn` — implement the P0 version; it subsumes the toolbar-scoped one.

---

## Toolbar (topbar)

`index.html` L14–26, `src/style.css` topbar block (L60–115).

| Title | Problem | Proposal | Pri | Eff |
|---|---|---|---|---|
| Focus-visible on topbar controls | No focus ring on `#projectName`, `#savedList`, `.tb-btn` when tabbing. | Covered by the **global `:focus-visible`** rule (P0). Do not add a topbar-only duplicate. | P1 | S |
| Active/pressed state on toolbar buttons | `.tb-btn.primary` shows "on" but no press/active feedback. | `.tb-btn:active { transform: scale(0.98); }` and `.tb-btn.primary:focus-visible { box-shadow: 0 0 0 2px var(--accent); }`. | P2 | S |
| Widen + truncate project-name input | `#projectName` fixed 120px truncates "Evening Broadcast 2025-06-23"; no overflow feedback. | `min-width:140px; flex:0 1 auto; max-width:200px`; add `title` with full name. | P1 | S |
| Improve saved-projects dropdown width | `#savedList max-width:150px` truncates saved names. | `min-width:160px; flex:0 1 auto; max-width:220px`. | P1 | S |
| Justify the `margin-left:auto` gap | Unexplained gap before Timeline toggle grows on narrow viewports. | Replace `margin-left:auto` with a `flex:1` spacer capped at `max-width:200px`, or `justify-content:space-between`; add CSS comment. | P1 | M |
| Responsive topbar for narrow windows | `<600px` wrap leaves Timeline button alone + wasted whitespace. | `@media (max-width:600px)`: stack `#topbar` column, `.tb-right` full-width, drop `margin-left:auto`. | P2 | M |
| Tooltip on Timeline toggle | `🎞 Timeline` has no `title`; `.primary` = open isn't obvious. | Add `title="Toggle the director timeline dock (shows at bottom when open)"`. | P2 | S |
| Visual divider between brand/badge and project controls | Two functional groups undifferentiated; badge floats. | `.tb-group:first-child { padding-right:10px; border-right:1px solid var(--line); }`. | P2 | M |
| Status badge: loading affordance + state variants | `#avatarStatus` static; no animation, no error/success styling. | **Merge** the animated-dot loading item with the badge-state item: add `.badge.loading::after` pulse, plus `.badge.success/.error/.warning` (color-coded per audit). Set `dom.statusEl.className = 'badge ' + state` from `context.ts`/`main.ts`. | P1 | M |
| R2 connectivity indicator | Save → R2 with no feedback if R2 is down/failed. | Reuse the badge-state system above: when `projectStore.r2On` is false, add `.disconnected`/`.warning` and update Save `title`. Avoids a second bespoke indicator. | P2 | M |

---

## Left panel — script + voice

`index.html` script/voice sections (L34–68), `src/app/performer.ts`, `voicePicker.ts`, new `app/scriptEditor.ts`.

| Title | Problem | Proposal | Pri | Eff |
|---|---|---|---|---|
| Console eats the script panel | `.grp-grow` (`flex:1; min-height:120px`) grows Console to 60%+ of panel. | `max-height:150px; overflow-y:auto`; move Console to bottom; add `console` to `COLLAPSED_BY_DEFAULT`. | P1 | S |
| Replace verbose tag hint with clickable chips | 8 gestures + 10 emotions inline as plain text — hard to scan/copy. | Two chip rows (Gestures / Emotions) below the textarea; click inserts `[tag]` at cursor. Keep one-line hint. New `app/scriptEditor.ts`. | P1 | M |
| Disambiguate live-line vs script editor | Live-line textarea visually identical to script; "Speak (stream)" conflates modes. | Move live-line into a "Live Performance" subsection below script; label "Ad-lib line (perform live)"; rename Speak → "▶ Play script". | P1 | M |
| Gesture reference (discoverability) | Tags only documented in hint; no way to preview what each looks like. | **Fold into the chip row**: hover tooltips on gesture chips ("[wave] – greeting") + a `(?)` popover. Don't build a separate modal system. | P2 | M |
| Script textarea affordance | `rows=7` freezes height; no signal it accepts multi-paragraph scripts. | `min-height:120px; max-height:240px`; drop/shrink `rows`; inline hint "Multi-paragraph scripts supported — use [tags]." | P2 | S |
| Mode toggle + shortcuts (Script ↔ Live) | No affordance/shortcut to switch focus between script and ad-lib. | Toggle group "○ Script · ● Live" + Ctrl+1/Ctrl+2; highlight active textarea. Build on the live-line subsection above. | P2 | M |
| Tag linter for malformed tags | `[wace]` / `[wave` silently ignored; discovered only at playback. | `app/scriptLinter.ts` + "Validate script" button; log "Line 3: unrecognized tag [wace], did you mean [wave]?". | P2 | M |
| Rate/Pitch sliders show value + units | 0.6–1.4 sliders show no number; meaning opaque. | `<output>` per slider ("1.00x"); hover hint. **Use the shared slider-value pattern** (see Design System). | P2 | S |
| Emotion select visual context | Plain `<select>`; no emoji/color for affect. | Emoji map in `performer.ts` (happy→😊, serious→😐…); show next to select. | P2 | S |
| Voice/expression grouping + relabel | Emotion grouped with Rate/Pitch implies it's a TTS param; it's a facial bias. | Subsection "VOICE & EXPRESSION"; divider between Rate/Pitch and emotion; rename "Default emotion" → "Face emotion". | P2 | S |

---

## Viewport (overlays + on-canvas controls)

`#stage`, `#cameraGate`, `#gateLabel`, `#viewHint`, `#pipFrame`; `src/scene/stage.ts`, `app/avatarTransform.ts`, `app/recording.ts`, new `cameraQuickAccess.ts`.

| Title | Problem | Proposal | Pri | Eff |
|---|---|---|---|---|
| Clarify capture gate + aspect label | Gate border faint (0.7); `#gateLabel` shows px only. | Border opacity 1.0, faint inner wash `rgba(91,140,255,0.05)`; label `1080p · 1920×1080` via `recording.ts` L57. | P1 | S |
| Floating shot/reset buttons in viewport | Reset/Shot/Align live in right panel; require scrolling. | `cameraQuickAccess.ts` widget top-right of `#stage`: Close/Medium/Wide + Reset camera + ⊕ Align to face → `stage.frame()`. | P1 | M |
| Gizmo discoverability hint | "✥ Edit avatar in 3D" in sidebar; G hotkey hidden. | When gizmo off, faint center overlay "(Press G) to edit avatar"; toggle via `gizmoOn` in `avatarTransform.ts`; `pointer-events:none`. | P1 | M |
| Collapsible / auto-hiding view hint | `#viewHint` always-on, verbose, clutters for experts. | Close "X" / press "H" to dismiss; auto-hide on first drag/scroll; persist in sessionStorage. | P2 | M |
| OUTPUT PiP toggle + sync indicator | `#pipFrame` always visible, can obscure framing; no sync cue. | "X" close + `.hidden`; recording pulse/checkmark when recording; persist in localStorage. | P2 | M |
| Safe-area / rule-of-thirds overlay | Gate is a bare rect; no headroom/cutoff guides. | Optional grid/safe-zone in `stage.ts resize()`; "Safe area: Off/On" toggle in Studio. | P2 | L |
| Auto-align active feedback | Auto-align toggle has no viewport feedback. | Pulsing glow / lock icon on `#cameraGate` via `.auto-aligning` class dispatched from `avatarTransform.ts` L76. | P2 | S |
| Camera reset / shot-change feedback | Camera snaps with no confirmation. | 300ms gate-border pulse / label flash on `stage.frame()` custom event. | P2 | M |
| First-load welcome overlay | Blank viewport; 3 interaction modes undiscoverable. | First-load (localStorage) semi-transparent overlay: "🎥 Drag to rotate · ⊕ Press G to edit · ⚡ Right-drag to pan"; dismiss on click/Esc. | P2 | M |
| Overlay label repositioning | `#gateLabel`/`#viewHint`/PiP compete in corners on small screens. | Media query `<1024px` or gizmo-active: move `#gateLabel` to top-center; keep corners free. | P2 | S |

---

## Right panel (export, avatar, lip-sync, transform, lighting, look, back screen)

`index.html` L81–208; `src/app/{lighting,look,backScreen,avatarTransform,dom,collapsible}.ts`.

| Title | Problem | Proposal | Pri | Eff |
|---|---|---|---|---|
| Lip-sync + Look collapsed by default | Right panel is a wall of controls at load. | `COLLAPSED_BY_DEFAULT = ['lip-sync','transform','look','back screen']`; verify substring matches headings. **Merges the two collapse-default audit items.** | P1 | S |
| Live numeric readout on all sliders | Lighting/look/lip-sync ranges give no value feedback. | Per-slider `<span class="slider-value">`; integer vs 2-dp formatting; wire `input` events. **Implement via the shared slider helper** (Design System). | P1 | M |
| Reset-to-preset buttons (lighting + look) | Tweaking sliders after a preset has no undo anchor. | `#lightReset` / `#lookReset` "↻ Reset to preset" re-apply `LIGHT_PRESETS`/`LOOK_PRESETS`; refs in `dom.ts`. | P1 | M |
| Export Format/Codec visible labels | `captureFormat`/`videoCodec` tiny, label-less (title only). | Add `<label>`s above selects; stack as `grid2` or add `.tl-dim` "output resolution and compression codec". | P1 | S |
| Studio vs Look section subtitles | Two look-controlling sections; overlapping purpose unclear. | `.tl-dim` subtitles: Studio = "light sources + exposure", Look = "post-process (bloom, grain, vignette…)". | P2 | S |
| Lip-sync hints + Save enablement | Dense sliders; "Test lips" / disabled "Save to avatar" unexplained. | `.tl-dim` hint; button → "Test lips (plays audio)"; `title="enabled after adjusting sliders"`; enable Save on slider change. | P2 | M |
| Transform & Camera button grouping | 7 buttons feel like a junk drawer. | Reorder into Gizmo / Camera-reset / Avatar-behavior groups via spacing (`.subgroup` margins). | P2 | S |
| Avatar load controls clarity | "Load .glb" vs "Load" (URL) similar styling; shot select misgrouped. | Group file + URL load in one `.row`; shot select solo below; rename "Load .glb" → "Load from file". | P2 | S |
| Back Screen & Cast restructure | Verbose technical hint buried; URL/file/Cast roles unclear. | Sub-actions: URL+Play, file load, Cast; condense hint to one `.tl-dim` line; optional wall-status line. | P2 | S |
| Toggle-button visual consistency | Toggles reuse `.primary`, look like primary actions (Export/Speak). | Add `.toggle` + `.toggle.on { background:var(--accent2); }` (green) for `studioToggle`, `autoAlignBtn`, `idleMotionToggle`, `screenCastBtn`, `camSourceBtn`; update controllers. | P2 | M |

---

## Timeline (bottom dock)

`src/timeline/ui.ts`, `catalog.ts`, `src/style.css` timeline block (L202–366).

| Title | Problem | Proposal | Pri | Eff |
|---|---|---|---|---|
| Consolidate +Camera/+Motion into one + menu | 14 controls in one row; two wide `<select>`s overcrowd `tl-bar`. | Single `addMenu('both')` button → categorized popover (Camera / Motion) auto-populated from `CATALOG`; closes on click-outside. | P1 | M |
| Playhead scrubbing affordance | 2px line, `pointer-events:none`; 12px time label; no drag cue. | Drag handler on playhead/±8px; `cursor:grab`; time label 14px/600; 16px invisible hit-zone; `pointer-events:auto`. | P1 | S |
| Timeline zoom control | Fixed auto `pxPerSec`; long timelines compress, short waste space. | `tl-zoom` range (0.5–2, step 0.1) in `tl-bar`; `zoomLevel` multiplies auto `pxPerSec`; `recalcLayout()`. **Merges both zoom audit items.** | P1 | M |
| Keyboard shortcuts | Only Delete/Backspace handled; no Space/arrow scrubbing. | Space = preview toggle; ←/→ = ±0.1s, Shift = ±1s; A = add audio; C/M = open + menu. Guard on timeline focus. | P2 | M |
| Cue label readability | Long narration/motion labels truncate silently; tiny cues blank. | First 3–4 words + ellipsis for narration; `text-overflow:ellipsis`; font 10→11px; padding/height bump; title = current label. | P2 | S |
| Snap feedback while dragging | 0.1s snapping has no visual guide. | `.tl-snap-guide` 1px blue line shown at snapped time during drag; hide on pointerup. | P2 | M |
| Lane labels: count + sizing | Static 78px labels; no cue count; misaligned heights. | `Name (n)` counts refreshed on render; label height 34→40px, `space-between`, font 11→12px. | P2 | S |
| Cue visual hierarchy | Flat colors; read-only narration looks editable; weak selected state. | `.tl-cue.readonly { opacity:.8; border-left:3px solid var(--muted); }`; hover shadow; stronger `.sel` glow; color legend on lane labels. | P2 | S |
| Ruler readability | Tick step jumps unpredictably; 9px labels jam at low zoom. | Adaptive `minPxBetweenTicks≈60`; ruler 18→24px; half-ticks; `tabular-nums`. | P2 | M |
| Length + Clear cramped; no undo | 54px Length input; accidental Clear wipes all cues irreversibly. | Widen `tl-num` to 70px; confirm dialog on Clear; 5-state `undoStack` + Undo button. | P2 | L |

---

## Design system / cross-cutting

`src/style.css` `:root` + new `src/components/slider.ts`. These back many items above — build them early so panel/timeline work consumes them.

| Title | Problem | Proposal | Pri | Eff |
|---|---|---|---|---|
| Global `:focus-visible` ring | No focus indicator anywhere — WCAG 2.4.7 fail. | `button, input, select, .filebtn { :focus-visible { outline:2px solid var(--accent); outline-offset:2px; } }`. Subsumes the toolbar-only focus item. | P0 | S |
| Disabled-button contrast | `opacity:0.45` fails AA; "Stop" barely visible. | `button:disabled { color:var(--muted); background:rgba(0,0,0,.2); border-color:rgba(40,49,67,.6); }`. | P0 | S |
| Collapsible header hover state | `.grp > h2` clickable but no hover feedback. | `.panel .grp > h2:hover { background:rgba(91,140,255,.08); border-radius:4px; }`. | P1 | S |
| Badge state variants (success/error/warning + loading) | Badge only shows text; no error/success styling or load animation. | Define `.badge.{success,error,warning,loading}` once; drives topbar status, R2 status, avatar-load. **Single source for all badge states.** | P1 | M |
| Reusable slider component | Raw `<input type=range>` repeated 25+ times; no value/unit display. | `src/components/slider.ts createSlider(id,label,min,max,step,value,unit?,onChange?)` emitting label + range + `.slider-value`. **Backs every "slider value" item** (Rate/Pitch, lighting, look, lip-sync). | P2 | L |
| Spacing + radius scale | Radius (7/8/5/999px) and padding (4–12px) ad-hoc. | `:root` `--radius-{sm,md,lg}` + `--sp-{xs..xl}`; map buttons/inputs/badges/cues. **Merges the two design-token audit items.** | P1 | M |
| Unified button padding | `.tb-btn`/`button`/`.tl-btn`/`.tl-add` all differ. | Standardize to `var(--sp-md) var(--sp-lg)`; depends on the spacing scale above. | P2 | M |

---

## Suggested sequencing

### Phase 1 — Polish & quick wins (mostly CSS / config; ship in a day)
- Global `:focus-visible` ring (P0)
- Disabled-button contrast (P0)
- Lip-sync + Look + Console collapse-by-default (`collapsible.ts`) (P1)
- Console height cap + move to bottom (P1)
- Collapsible header hover state (P1)
- Capture gate clarity + aspect label (P1)
- Export Format/Codec labels (P1)
- Toolbar active/pressed feedback; widen `#projectName` + `#savedList`; Timeline tooltip (P1/P2)
- Playhead grab cursor + bolder time label (the S part of timeline scrubbing) (P1)

### Phase 2 — Design system foundation (unblocks everything denser)
- Spacing + radius scale + unified button padding
- Badge state variants (success/error/warning/loading) — then wire topbar status + R2 status
- `createSlider` component → roll out live numeric readouts across Rate/Pitch, lighting, look, lip-sync
- Reset-to-preset buttons (lighting + look)

### Phase 3 — Timeline
- Consolidated +Camera/+Motion popover menu
- Zoom control
- Full playhead drag-scrubbing + snap guide
- Keyboard shortcuts (Space/arrows/A/C/M)
- Cue labels, lane label counts, cue hierarchy, ruler readability
- Length/Clear confirm + Undo stack (largest item, last)

### Phase 4 — Viewport & script-editor UX
- Floating shot/reset/align quick-access widget
- Gizmo discoverability + first-load welcome overlay + view-hint dismiss
- Auto-align / reset feedback; PiP toggle; overlay repositioning; safe-area grid (L)
- Script chip rows + gesture tooltips; live-line "Live Performance" subsection + Play-script rename; mode toggle + shortcuts; tag linter; emotion emoji / face-emotion relabel

> Topbar gap/responsive items can slot into Phase 1 (CSS) or Phase 4 alongside other layout work, depending on appetite.
