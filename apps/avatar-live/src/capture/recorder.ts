// Records the virtual camera (the WebGL canvas) to a downloadable clip. An
// optional audio MediaStreamTrack can be mixed in for the cloned-voice path;
// Web Speech audio is not capturable by the browser, so local-demo recordings
// are video-only.
export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  constructor(
    private getVideo: () => MediaStream,
    private getAudioTrack?: () => MediaStreamTrack | null,
  ) {}

  get active(): boolean {
    return this.rec?.state === 'recording';
  }

  start(): void {
    const stream = this.getVideo();
    const audio = this.getAudioTrack?.();
    if (audio) stream.addTrack(audio);
    const mime = pickMime();

    // High bitrate from the actual capture resolution — the browser default
    // (~2.5 Mbps) is what makes clips look blocky. ~0.13 bits/pixel/frame ≈
    // 1080p→8Mbps, 1440p→15Mbps, 4K→32Mbps.
    const track = stream.getVideoTracks()[0];
    const s = track?.getSettings?.() ?? {};
    const w = s.width ?? 1920;
    const h = s.height ?? 1080;
    const videoBitsPerSecond = Math.round(w * h * 30 * 0.13);

    this.chunks = [];
    this.rec = new MediaRecorder(stream, {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond,
      audioBitsPerSecond: 128_000,
    });
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.rec.start();
  }

  /** Stop and resolve a download URL + suggested filename. */
  stop(): Promise<{ url: string; filename: string }> {
    return new Promise((resolve) => {
      const rec = this.rec;
      if (!rec) return resolve({ url: '', filename: '' });
      rec.onstop = () => {
        const type = rec.mimeType || 'video/webm';
        const blob = new Blob(this.chunks, { type });
        const ext = type.includes('mp4') ? 'mp4' : 'webm';
        resolve({ url: URL.createObjectURL(blob), filename: `avatar-take.${ext}` });
      };
      rec.stop();
    });
  }
}

function pickMime(): string {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}
