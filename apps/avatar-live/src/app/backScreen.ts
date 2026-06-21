import type { StudioContext } from './context.js';

type ScreenState = { kind: 'url' | 'r2' | 'file'; src: string; blob?: Blob } | null;

/** The studio back-wall video: play a URL/file, cast a tab/screen, and switch the
 *  output camera between the scene and the screen. */
export class BackScreen {
  private wallVideo = document.createElement('video');
  private wallAudioWired = false;
  private castStream: MediaStream | null = null;
  private castAudioNode: MediaStreamAudioSourceNode | null = null;
  // What's on the wall, for project persistence (a live cast can't be persisted).
  private backScreen: ScreenState = null;

  constructor(private app: StudioContext) {
    this.wallVideo.playsInline = true;
    this.wallVideo.crossOrigin = 'anonymous';
    this.wallVideo.loop = false;
  }

  get video(): HTMLVideoElement {
    return this.wallVideo;
  }
  get state(): ScreenState {
    return this.backScreen;
  }
  setUploaded(key: string): void {
    this.backScreen = { kind: 'r2', src: key };
  }

  private wireWallAudio(): void {
    if (this.wallAudioWired) return;
    const ctx = this.app.audio();
    try {
      const src = ctx.createMediaElementSource(this.wallVideo);
      src.connect(ctx.destination);
      if (this.app.recordDest) src.connect(this.app.recordDest);
      this.wallAudioWired = true;
    } catch {
      /* already wired */
    }
  }
  private showOnWall(): void {
    this.app.studio.setScreenVideo(this.wallVideo);
    this.app.stage.setScreenSource(this.wallVideo);
    void this.wallVideo.play().catch((e) => this.app.log(`video play blocked: ${String(e)}`));
  }
  private stopCast(): void {
    this.castAudioNode?.disconnect();
    this.castAudioNode = null;
    this.castStream?.getTracks().forEach((t) => t.stop());
    this.castStream = null;
  }
  loadWallVideo = async (src: string, label: string): Promise<void> => {
    this.stopCast();
    this.wireWallAudio();
    this.wallVideo.srcObject = null;
    this.wallVideo.src = src;
    this.wallVideo.muted = false;
    this.showOnWall();
    this.app.log(`back screen: playing ${label}.`);
  };
  revertScreen = (): void => {
    this.stopCast();
    this.backScreen = null;
    this.wallVideo.pause();
    this.wallVideo.srcObject = null;
    this.wallVideo.src = '';
    this.app.studio.setScreenVideo(null);
    this.app.stage.setScreenSource(null); // also resets the output to 'scene'
    this.updateCamSourceLabel();
    this.app.log('back screen: headline restored.');
  };
  private updateCamSourceLabel(): void {
    const on = this.app.stage.outputIsScreen;
    this.app.dom.camSourceBtn.textContent = `Camera source: ${on ? 'Screen' : 'Scene'}`;
    this.app.dom.camSourceBtn.classList.toggle('primary', on);
  }

  serialize(): { backScreen: { kind: 'url' | 'r2'; src: string } | null } {
    const bs = this.backScreen;
    return { backScreen: bs && bs.kind !== 'file' ? { kind: bs.kind, src: bs.src } : null };
  }
  apply(doc: { backScreen?: { kind: 'url' | 'r2'; src: string } | null }, r2Url: (k: string) => string): void {
    this.revertScreen();
    if (doc.backScreen) {
      const src = doc.backScreen.kind === 'r2' ? r2Url(doc.backScreen.src) : doc.backScreen.src;
      this.backScreen = { kind: doc.backScreen.kind, src: doc.backScreen.src };
      void this.loadWallVideo(src, 'back screen');
    }
  }

  init(): void {
    const d = this.app.dom;
    d.screenLoadBtn.addEventListener('click', () => {
      const url = d.screenUrlInput.value.trim();
      if (!url) return;
      this.backScreen = { kind: 'url', src: url };
      void this.loadWallVideo(url, url.split('/').pop() || 'video');
    });
    d.screenUrlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') d.screenLoadBtn.click();
    });
    d.screenFileInput.addEventListener('change', () => {
      const file = d.screenFileInput.files?.[0];
      if (!file) return;
      const obj = URL.createObjectURL(file);
      this.backScreen = { kind: 'file', src: obj, blob: file };
      void this.loadWallVideo(obj, file.name);
      d.screenFileInput.value = '';
    });
    d.screenCastBtn.addEventListener('click', async () => {
      const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: (c: unknown) => Promise<MediaStream> };
      if (!md.getDisplayMedia) {
        this.app.log('casting needs a browser that supports screen capture (getDisplayMedia).');
        return;
      }
      try {
        this.stopCast();
        this.castStream = await md.getDisplayMedia({ video: true, audio: true });
        this.backScreen = null; // a live cast isn't persistable
        this.wireWallAudio();
        this.wallVideo.src = '';
        this.wallVideo.srcObject = this.castStream;
        this.wallVideo.muted = true;
        if (this.castStream.getAudioTracks().length && this.app.recordDest) {
          this.castAudioNode = this.app.audio().createMediaStreamSource(this.castStream);
          this.castAudioNode.connect(this.app.recordDest);
        }
        this.showOnWall();
        this.castStream.getVideoTracks()[0]?.addEventListener('ended', () => {
          this.app.log('cast ended.');
          this.revertScreen();
        });
        this.app.log('casting a tab/screen onto the wall.');
      } catch (err) {
        this.app.log(`cast cancelled: ${String(err)}`);
      }
    });
    d.screenStopBtn.addEventListener('click', this.revertScreen);
    d.camSourceBtn.addEventListener('click', () => {
      if (!this.wallVideo.src && !this.wallVideo.srcObject) {
        this.app.log('load a video / cast first, then switch the camera to the screen.');
        return;
      }
      this.app.stage.setOutputSource(this.app.stage.outputIsScreen ? 'scene' : 'screen');
      this.updateCamSourceLabel();
    });
  }
}
