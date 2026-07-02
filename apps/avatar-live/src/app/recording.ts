import { Recorder } from '../capture/recorder.js';
import { canExportMp4, type VideoCodecChoice } from '../capture/mp4Encoder.js';
import type { StudioContext } from './context.js';

const CAPTURE_FORMATS = [
  { name: '1080p (16:9)', w: 1920, h: 1080 },
  { name: '1440p (16:9)', w: 2560, h: 1440 },
  { name: '4K UHD (16:9)', w: 3840, h: 2160 },
  { name: '720p (16:9)', w: 1280, h: 720 },
  { name: 'vertical 1080×1920 (9:16)', w: 1080, h: 1920 },
  { name: 'square 1080 (1:1)', w: 1080, h: 1080 },
];

/** MediaRecorder capture of the stage + the capture-format selector. */
export class Recording {
  private recorder: Recorder;
  constructor(private app: StudioContext) {
    this.recorder = new Recorder(
      () => app.stage.captureStream(30),
      () => app.recordDest?.stream.getAudioTracks()[0] ?? null,
    );
  }

  get active(): boolean {
    return this.recorder.active;
  }

  start(): void {
    this.recorder.start();
  }
  async stop(): Promise<{ url: string; filename: string }> {
    return this.recorder.stop();
  }

  setRecUi(on: boolean): void {
    const d = this.app.dom;
    d.recordBtn.textContent = on ? '■ Stop preview' : '● Quick preview (webm)';
    d.recordBtn.classList.toggle('rec', on);
    d.pipFrameEl.classList.toggle('rec', on);
  }

  downloadClip(url: string, filename: string): void {
    if (!url) return;
    const d = this.app.dom;
    // Revoke the PREVIOUS take's object URL before overwriting it — each export/recording
    // otherwise pins its whole blob in memory for the page lifetime.
    const prev = d.downloadEl.href;
    if (prev.startsWith('blob:') && prev !== url) URL.revokeObjectURL(prev);
    d.downloadEl.href = url;
    d.downloadEl.download = filename;
    d.downloadEl.textContent = `⬇ Download ${filename}`;
    d.downloadEl.hidden = false;
    d.downloadEl.click();
    this.app.log(`clip ready — downloading ${filename}`);
  }

  private applyFormat = (): void => {
    const d = this.app.dom;
    const f = CAPTURE_FORMATS[Number(d.captureFormatSel.value)] ?? CAPTURE_FORMATS[0];
    this.app.stage.setCaptureFormat(f);
    d.gateLabelEl.textContent = `${f.name} · ${f.w}×${f.h}`;
  };

  /** The currently selected capture resolution. */
  currentFormat(): { w: number; h: number } {
    const f = CAPTURE_FORMATS[Number(this.app.dom.captureFormatSel.value)] ?? CAPTURE_FORMATS[0];
    return { w: f.w, h: f.h };
  }

  /** The currently selected export codec ('avc' default, 'hevc' if the user picked it). */
  currentCodec(): VideoCodecChoice {
    return (this.app.dom.videoCodecSel.value as VideoCodecChoice) ?? 'avc';
  }

  /** Disable export/preview controls while an export is running. */
  setExportUi(on: boolean): void {
    const d = this.app.dom;
    d.exportMp4Btn.disabled = on;
    d.recordBtn.disabled = on;
    d.exportMp4Btn.textContent = on ? '… exporting' : '⬇ Export MP4';
    d.exportCancelBtn.hidden = !on; // Cancel is visible exactly while an export runs
  }

  /** Show export progress; (0,0) clears it. */
  setExportProgress(done: number, total: number): void {
    this.app.dom.exportProgressEl.textContent = total > 0 ? `${Math.round((done / total) * 100)}%` : '';
  }

  /** Probe MP4 capability; annotate or disable the H.265 option when unavailable. */
  private async probeCodecs(): Promise<void> {
    const d = this.app.dom;
    const okMp4 = await canExportMp4(1920, 1080);
    if (!okMp4) {
      this.app.log('note: this browser lacks WebCodecs MP4 — Export MP4 will fall back to webm.');
    }
    const { pickVideoCodec } = await import('../capture/mp4Encoder.js');
    const hevc = await pickVideoCodec('hevc', 1920, 1080);
    if (hevc !== 'hevc') {
      const opt = Array.from(d.videoCodecSel.options).find((o) => o.value === 'hevc');
      if (opt) {
        opt.textContent = 'H.265 / HEVC (unsupported here)';
        opt.disabled = true;
      }
    }
  }

  init(): void {
    const d = this.app.dom;
    CAPTURE_FORMATS.forEach((f, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `${f.name} — ${f.w}×${f.h}`;
      d.captureFormatSel.appendChild(o);
    });
    d.captureFormatSel.addEventListener('change', this.applyFormat);
    this.applyFormat();
    void this.probeCodecs();
  }
}
