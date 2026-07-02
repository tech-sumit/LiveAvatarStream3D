import { validateNewsReportDoc, compileNewsReport, validateScore } from '@las/protocol';
import type { Stage, AudioTimings, Performance, AudioCue, NewsReportDoc, SlideContent } from '@las/protocol';
import { r2Available, r2GetJson, r2List, r2PutBlob, r2PutJson, r2Url, resolveAssetUrl } from '../storage/r2.js';
import type { Cue } from '../timeline/types.js';
import type { StudioContext } from './context.js';
import type { AvatarLibrary } from './avatarLibrary.js';
import type { VoicePicker } from './voicePicker.js';
import type { Lighting } from './lighting.js';
import type { Look } from './look.js';
import type { LookParams } from '../look/lookChain.js';
import type { BackScreen } from './backScreen.js';
import type { TimelineEditor } from './timelineEditor.js';
import type { Performer } from './performer.js';

interface ProjectDoc {
  version: number;
  name: string;
  script: string;
  voiceId: string;
  rate: number;
  pitch: number;
  emotion: string;
  avatarUrl: string;
  shot: string;
  studioOn: boolean;
  idleMotion: boolean;
  headline: string;
  lights: { key: number; fill: number; rim: number; ambient: number; exposure: number; warmth: number; preset: string };
  look?: { preset?: string; params?: LookParams };
  backScreen: { kind: 'url' | 'r2'; src: string } | null;
  timeline: { duration: number; cues: Cue[] };
}

const PROJECT_PREFIX = 'projects/';
const LOCAL_INDEX = 'las.projects';
const SAMPLE_VALUE = '__sample:showcase';
const SAMPLE_URL = '/samples/showcase.project.json';
const sanitize = (n: string) => (n.trim() || 'untitled').replace(/[^\w.-]+/g, '_');

export interface ProjectStoreDeps {
  library: AvatarLibrary;
  voices: VoicePicker;
  lighting: Lighting;
  look: Look;
  backScreen: BackScreen;
  timeline: TimelineEditor;
  performer: Performer;
}

/** Project persistence (Cloudflare R2 with a localStorage fallback) — gathers each
 *  controller's serialize() slice and distributes apply() on load. */
export class ProjectStore {
  private r2On = false;
  constructor(
    private app: StudioContext,
    private c: ProjectStoreDeps,
  ) {}

  private assetUrl(src: string): string {
    return resolveAssetUrl(src); // the ONE shared rule (blob:/data:/http/rooted pass through)
  }
  private async fetchAssetBlob(src: string): Promise<Blob> {
    const r = await fetch(this.assetUrl(src));
    if (!r.ok) throw new Error(`asset ${r.status}`);
    return r.blob();
  }
  private listLocal(): string[] {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_INDEX) || '[]') as string[];
    } catch {
      return [];
    }
  }

  private async refreshSavedList(): Promise<void> {
    const sel = this.app.dom.savedListSel;
    let names: string[] = [];
    if (this.r2On) {
      try {
        names = (await r2List(PROJECT_PREFIX)).filter((k) => k.endsWith('.json')).map((k) => k.slice(PROJECT_PREFIX.length, -5));
      } catch {
        names = [];
      }
    } else {
      names = this.listLocal();
    }
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = names.length ? `— load saved (${this.r2On ? 'R2' : 'local'}) —` : `(none saved · ${this.r2On ? 'R2' : 'local'})`;
    sel.appendChild(def);
    const sample = document.createElement('option');
    sample.value = SAMPLE_VALUE;
    sample.textContent = '★ Showcase (sample)';
    sel.appendChild(sample);
    for (const n of names.sort()) {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = n;
      sel.appendChild(o);
    }
  }

  private async loadSample(): Promise<void> {
    try {
      const r = await fetch(SAMPLE_URL);
      if (!r.ok) throw new Error(`${r.status}`);
      await this.applyProject((await r.json()) as ProjectDoc);
      this.app.dom.projectNameEl.value = 'showcase';
      this.app.log('loaded the bundled showcase sample — click 🎙 Generate to synthesize narration.');
    } catch (err) {
      this.app.log(`couldn't load sample: ${String(err)}`);
    }
  }

  private serializeProject(name: string): ProjectDoc {
    const d = this.app.dom;
    return {
      version: 2,
      name,
      script: d.scriptEl.value,
      ...this.c.voices.serialize(),
      emotion: d.emotionSel.value,
      ...this.c.library.serialize(),
      shot: d.shotSel.value,
      ...this.c.lighting.serialize(),
      ...this.c.look.serialize(),
      ...this.c.backScreen.serialize(),
      ...this.c.timeline.serialize(),
    };
  }

  // Upload session-only assets (audio clips, a back-screen file) to R2 and rewrite
  // their references to R2 keys so the saved project is self-contained.
  private async uploadAssets(): Promise<void> {
    if (!this.r2On) return;
    const jobs: Promise<void>[] = [];
    for (const cue of this.c.timeline.timeline.cues) {
      if (cue.track !== 'audio' || cue.src) continue;
      const blob = this.c.timeline.blobs.get(cue.id);
      if (!blob) continue;
      const key = `assets/${crypto.randomUUID()}-${sanitize(cue.label ?? 'audio')}`;
      jobs.push(
        r2PutBlob(key, blob).then(() => {
          cue.src = key;
        }),
      );
    }
    const bs = this.c.backScreen.state;
    if (bs?.kind === 'file' && bs.blob) {
      const ext = (bs.blob.type.split('/')[1] || 'mp4').replace(/[^\w]+/g, '');
      const blob = bs.blob;
      const key = `assets/${crypto.randomUUID()}-backscreen.${ext}`;
      jobs.push(
        r2PutBlob(key, blob).then(() => {
          this.c.backScreen.setUploaded(key);
        }),
      );
    }
    await Promise.all(jobs);
  }

  private downloadJson(filename: string, obj: unknown): void {
    const d = this.app.dom;
    const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
    d.downloadEl.href = url;
    d.downloadEl.download = filename;
    d.downloadEl.textContent = `⬇ ${filename}`;
    d.downloadEl.hidden = false;
    d.downloadEl.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  private async saveProject(): Promise<void> {
    const d = this.app.dom;
    const name = sanitize(d.projectNameEl.value);
    d.saveTimelineBtn.disabled = true;
    try {
      await this.uploadAssets();
      const doc = this.serializeProject(name);
      if (this.r2On) {
        await r2PutJson(`${PROJECT_PREFIX}${name}.json`, doc);
        await this.refreshSavedList();
        this.app.log(`saved project "${name}" to R2 (state + timeline + assets).`);
      } else {
        localStorage.setItem(`las.project.${name}`, JSON.stringify(doc));
        const idx = this.listLocal();
        if (!idx.includes(name)) idx.push(name);
        localStorage.setItem(LOCAL_INDEX, JSON.stringify(idx));
        await this.refreshSavedList();
        this.app.log(`saved project "${name}" locally (R2 off — assets not persisted).`);
      }
      d.savedListSel.value = name;
    } catch (err) {
      this.app.log(`save failed: ${String(err)}`);
    } finally {
      d.saveTimelineBtn.disabled = false;
    }
  }

  /** Export the current project as a .json file to disk (separate from the R2 Save). */
  private exportProjectJson(): void {
    const name = sanitize(this.app.dom.projectNameEl.value);
    // Unlike Save (which runs uploadAssets first), a plain JSON export can't carry
    // session-only assets — audio cues whose file lives only in this tab's memory (no src)
    // serialize as absent. Warn LOUDLY instead of silently shipping a project that will
    // load without its audio.
    const sessionOnly = this.c.timeline.timeline.cues.filter(
      (c) => c.track === 'audio' && !c.src && this.c.timeline.blobs.has(c.id),
    );
    if (sessionOnly.length) {
      this.app.log(
        `⚠ export: ${sessionOnly.length} audio cue(s) exist only in this session (no cloud src) — ` +
          `they will be MISSING when this JSON is loaded. Use 💾 Save (R2) to persist them first.`,
      );
    }
    this.downloadJson(`${name}.project.json`, this.serializeProject(name));
    this.app.log(`exported "${name}.project.json" to disk.`);
  }

  /**
   * Import a NewsReportDoc (v2) into the studio: validate via @las/protocol,
   * compile to a ProjectDoc, and apply it. Public so the Studio Bridge can drive
   * the same path the timeline-file change-handler uses for a dropped newscast.
   * Returns the compiled project name (the newscast title, sanitized).
   */
  async importNewsReport(doc: unknown): Promise<string> {
    const validated = validateNewsReportDoc(doc);
    const { project } = compileNewsReport(validated);
    await this.applyProject(project as ProjectDoc);
    const title = validated.meta.title ?? 'untitled';
    this.app.dom.projectNameEl.value = sanitize(title);
    this.app.log(`imported newscast: ${title}`);
    return title;
  }

  /**
   * Land an authored {@link Score} on the studio's Score runtime (Phase 5). The Score
   * validates via `@las/protocol`'s `validateScore`, compiles via `compileScore` against
   * the supplied `stage` + per-word `timings`, and the resulting `Performance` is handed
   * to the `Performer`'s `ScoreDrive` — the SAME single drive path the live narration tick
   * and the offline export consume. This is the *defined consumer* of a compiled Performance
   * (the path the original plan left unwired). Returns the compiled `Performance`.
   */
  async importScore(
    doc: unknown,
    stage: Stage,
    timings: AudioTimings,
    audio?: AudioCue[],
    extra?: { nr?: NewsReportDoc; slides?: { tSec: number; slide: SlideContent }[] },
  ): Promise<Performance> {
    const score = validateScore(doc);
    // performer.loadScore compiles the provisional Performance AND retains the Score, so
    // Generate can recompile direction + chrome against the real TTS clock.
    const perf = this.c.performer.loadScore({
      score,
      stage,
      timings,
      ...(extra?.nr ? { nr: extra.nr } : {}),
      ...(audio?.length ? { audio } : {}),
      ...(extra?.slides?.length ? { slides: extra.slides } : {}),
    });
    this.app.log(`imported Score → ${perf.beats.length} beat(s) on stage "${stage.id}".`);
    return perf;
  }

  /**
   * Land a pre-compiled {@link Performance} directly on the studio's `ScoreDrive` (skips the
   * `compileScore` step for callers that already hold a Performance). Same landing path as
   * {@link importScore}.
   */
  applyPerformance(perf: Performance): void {
    this.c.performer.loadPerformance(perf);
    this.app.log(`applied Performance → ${perf.beats.length} beat(s).`);
  }

  private async applyProject(doc: ProjectDoc): Promise<void> {
    const { app, c } = this;
    // Single choke point for every load path (saved list, file drop, sample, newscast import):
    // applying a project mid-take swaps the avatar, replaces timeline cues, and re-decodes audio
    // under a running render — the same guard the avatar selectors already enforce.
    if (app.isBusy()) throw new Error('busy — finish the current take before loading a project.');
    const d = app.dom;
    d.scriptEl.value = doc.script ?? d.scriptEl.value;
    // Refresh the overlay highlighter / validity badge for the loaded script.
    d.scriptEl.dispatchEvent(new Event('input'));
    c.performer.invalidateNarration();
    c.voices.apply(doc);
    c.performer.setRate(Number(d.rateEl.value));
    d.emotionSel.value = doc.emotion ?? 'neutral';
    app.avatar.setEmotion(d.emotionSel.value as never);
    d.shotSel.value = doc.shot ?? 'medium';
    c.lighting.apply(doc);
    c.look.apply(doc);
    await c.library.apply(doc);
    c.timeline.applyTimelineDoc(doc.timeline);
    await c.timeline.loadAudioAssets((src) => this.fetchAssetBlob(src));
    // Resolve the wall-slide backdrop images (R2 keys / relative paths → final urls) and preload
    // them so the slide deck renders with imagery. Rewrite each graphics cue to its resolved url
    // so the studio's url-keyed cache hits when score.drive fires the slide (live == export).
    const slideUrls = new Set<string>();
    for (const cue of c.timeline.timeline.cues) {
      if (cue.track === 'graphics' && cue.slide?.image) {
        const url = this.assetUrl(cue.slide.image);
        cue.slide.image = url;
        slideUrls.add(url);
      }
    }
    if (slideUrls.size) await app.studio.preloadSlideImages([...slideUrls]);
    c.backScreen.apply(doc, r2Url);
    app.log(`loaded project "${doc.name}" — ${c.timeline.timeline.cues.length} cue(s).`);
  }

  private async loadNamed(name: string): Promise<void> {
    const d = this.app.dom;
    try {
      let doc: ProjectDoc;
      if (this.r2On) {
        doc = await r2GetJson<ProjectDoc>(`${PROJECT_PREFIX}${name}.json`);
      } else {
        const json = localStorage.getItem(`las.project.${name}`);
        if (!json) throw new Error('not found');
        doc = JSON.parse(json) as ProjectDoc;
      }
      await this.applyProject(doc);
      d.projectNameEl.value = name;
    } catch (err) {
      this.app.log(`load "${name}" failed: ${String(err)}`);
      void this.refreshSavedList();
    }
  }

  async init(): Promise<void> {
    const d = this.app.dom;
    d.saveTimelineBtn.addEventListener('click', () => void this.saveProject());
    d.exportJsonBtn.addEventListener('click', () => this.exportProjectJson());
    d.loadTimelineBtn.addEventListener('click', () => d.timelineFileEl.click());
    d.timelineFileEl.addEventListener('change', async () => {
      const file = d.timelineFileEl.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const isObj = data && typeof data === 'object';
        const isNewsReport =
          isObj &&
          (data as { version?: unknown }).version === 2 &&
          (data as { meta?: unknown }).meta &&
          Array.isArray((data as { rundown?: unknown }).rundown);
        const isProject = isObj && (typeof data.script === 'string' || (data.timeline && typeof data.timeline === 'object'));
        const isTimeline = isObj && Array.isArray(data.cues);
        if (isNewsReport) {
          await this.importNewsReport(data);
          d.projectNameEl.value = file.name.replace(/\.newscast\.json$|\.(project|timeline)\.json$|\.json$/i, '');
        } else if (isProject) {
          await this.applyProject(data as ProjectDoc);
          d.projectNameEl.value = file.name.replace(/\.(project|timeline)\.json$|\.json$/i, '');
        } else if (isTimeline) {
          this.c.timeline.applyTimelineDoc(data);
          this.app.log(`loaded timeline — ${this.c.timeline.timeline.cues.length} cue(s).`);
        } else {
          this.app.log('load failed: unrecognized file.');
        }
      } catch (err) {
        this.app.log(`load failed: ${String(err)}`);
      }
      d.timelineFileEl.value = '';
    });
    d.savedListSel.addEventListener('change', () => {
      if (d.savedListSel.value === SAMPLE_VALUE) void this.loadSample();
      else if (d.savedListSel.value) void this.loadNamed(d.savedListSel.value);
    });

    this.r2On = await r2Available();
    this.app.log(this.r2On ? 'persistence: Cloudflare R2.' : 'persistence: browser localStorage (set R2_* in .env for R2).');
    // Reflect persistence target on the Save control: warn (amber) when R2 is off so
    // the user knows projects only live in this browser's localStorage.
    const saveBtn = this.app.dom.saveTimelineBtn;
    saveBtn.classList.toggle('warn', !this.r2On);
    saveBtn.title = this.r2On
      ? 'Save the project to the cloud (R2)'
      : '⚠ R2 not configured — saving to this browser only (set R2_* in .env for cloud sync)';
    await this.refreshSavedList();
  }
}
