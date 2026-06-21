import { Recorder } from '../capture/recorder.js';
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
    d.recordBtn.textContent = on ? '■ Stop recording' : '● Record camera';
    d.recordBtn.classList.toggle('rec', on);
    d.pipFrameEl.classList.toggle('rec', on);
  }

  downloadClip(url: string, filename: string): void {
    if (!url) return;
    const d = this.app.dom;
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
    d.gateLabelEl.textContent = `${f.w}×${f.h}`;
  };

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
  }
}
