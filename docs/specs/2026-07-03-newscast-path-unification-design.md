# Newscast compile-path unification — design (system-review round 2)

**Status:** in progress · follows `2026-06-25-performance-score-dsl-design.md` and the
system-review round-1 PR (#64). Addresses the three HIGH structural defects the review
confirmed: the lossy `apply_newscast` path, the triple-clock mismatch, and the
shot-preset drop on the Score path.

## Problems (confirmed by the review)

1. **Lossy bridge path.** `apply_newscast` lowers a NewsReportDoc via
   `compileNewsReportToScore`, which structurally cannot carry avatar, wall slides,
   headline/ticker, look+lights, backScreen, idleMotion, or rate/pitch (Score has no
   grammar for them; `compileScore` hardcodes `slides: []`). The legacy file-import
   (`compileNewsReport` → `applyProject`) applies all of it. Same doc, different show.
2. **Triple clock.** The bridge Performance is compiled on a fake 3 s/beat grid
   (`timingsFromScore`), its beds/SFX on a WPM-estimate clock (`newsReportAudio`), while
   the take/export runs on the real TTS clock — direction/audio drift and exhaust early;
   `pauseMsAfter` is authored but consumed by nothing.
3. **Preset drop.** `compileNewsReportToScore` reads only `beat.camera.shot`, silently
   discarding the 10-framing preset catalog (and a preset cue could even force a spurious
   change to `medium`).

## Design

### A · Chrome parity by construction

When `applyScoreDoc` lowers a NewsReportDoc it now ALSO runs the **same lowering the
file path uses** — `compileNewsReport(nr)` — and applies its `project` chrome through
the **same appliers** `applyProject` calls: `voices.apply` (voiceId/rate/pitch),
`lighting.apply` (studioOn/idleMotion/headline/lights), `look.apply`, `library.apply`
(avatarUrl), `backScreen.apply`, plus the `graphic.slide` timeline cues (with R2 image
resolution + preload). Parity is by construction: one lowering, two entry points.
Score grammar is NOT extended with chrome (a pure Score still authors none) — that
remains the Score/Stage evolution; the confirmed defect was NR-via-bridge loss.

`compileScore` gains `extra.slides` (mirroring `extra.audio`) so the recompiled
Performance drives the wall deck during takes/exports (`advanceSlide` already works;
only the channel was empty). `validate_newscast`'s loss warnings are removed for the
channels now carried.

### B · One clock: synthesize-then-recompile

The Score (not just its compiled Performance) is retained after apply:
`performer.loadScore({ score, stage, nr?, audio, slides, timings })` compiles a
provisional Performance on the coarse clock (pre-TTS preview UX unchanged) and stores
the authored Score. When narration is generated, `buildNarration` detects the authored
Score and:

- synthesizes **per beat** from `score.beats[].text` (not the re-split textarea), with
  `pauseMsAfter` honored as the inter-beat gap (default 0.18 s) — authored pauses land;
- measures **real `AudioTimings`** per beat from the synthesized buffers;
- **recompiles**: `compileScore(stage, score, realTimings, …, { audio, slides })` where
  beds/SFX/slides are re-derived on the same real clock — the recompiled Performance
  replaces the provisional one and owns the take/export.

Beds/SFX/slides derive from one helper, `newsReportChrome(nr, timings)` → per-section
starts = the section's first beat `startSec` from the SAME `AudioTimings` used to
compile (replaces `newsReportAudio`'s private WPM clock; the music bed spans the real
total). Coarse and real passes both use it → two passes, one clock each, zero cross-clock
artifacts. Script edits (`invalidateNarration`) clear the authored Score along with the
Performance — an edited script drops back to the script-derived take.

### C · Presets through the Score path

- `score.ts` `CameraDirective` gains `{ preset: enum(CAMERA_SHOT_IDS) }`.
- `compileNewsReportToScore` lowers `beat.camera.preset` (doc/section defaults too) to
  that cue — and a preset cue no longer forces a spurious `medium` frame cue.
- `compileCamera` emits a keyframe carrying `preset` (schema: optional field on
  `CameraKeyframe`) plus a compile-time pose snapshot (`sampleShot` at t=0 against the
  self.face ref) so consumers without the resolver still frame sanely.
- `scoreDrive.advanceCamera` resolves a `preset` keyframe **against the live avatar**
  per frame via the studio's `poseForShotId` (head-height-correct, push-in progression
  from `t − kf.tSec`, dutch roll, follow) — identical on the live and export clocks.

## Testing

- Protocol: preset lowering (doc/beat/section), `extra.slides` → `Performance.slides`,
  `newsReportChrome` clock alignment (section starts == first-beat startSec; bed spans
  total), recompile determinism, `pauseMsAfter` consumed into timings.
- Studio (dispatch.test): bridge-vs-file **parity assertions** — the stub appliers
  record calls; the same doc applied via `apply_newscast` must hit the appliers with
  the `compileNewsReport` project values and import the graphics cues.
- Live: bridge-apply a chrome-rich newscast; verify avatar/slides/look land and a real
  export stays in sync (spot frames).

## Files

`packages/protocol`: score.ts, performance.ts, scoreCompile.ts (+tests) ·
`apps/avatar-live`: bridge/dispatch.ts, app/performer.ts, app/scoreDrive.ts,
app/projectStore.ts (+dispatch.test).
