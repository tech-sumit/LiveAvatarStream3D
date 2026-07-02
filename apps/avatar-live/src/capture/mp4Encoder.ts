import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  CanvasSource,
  AudioBufferSource,
  QUALITY_HIGH,
  getFirstEncodableVideoCodec,
  canEncodeAudio,
} from 'mediabunny';

export type VideoCodecChoice = 'avc' | 'hevc';

export interface Mp4EncoderOpts {
  canvas: HTMLCanvasElement; // the live capture canvas (Stage output canvas)
  fps: number;
  codec: VideoCodecChoice; // already resolved to a supported codec (see pickVideoCodec)
}

/**
 * Wraps Mediabunny + WebCodecs to mux a canvas video track plus one Web Audio
 * AudioBuffer into an in-memory MP4 Blob. Mediabunny owns the VideoEncoder/
 * AudioEncoder lifecycle + backpressure; awaiting add() is the throttle.
 */
export class Mp4Encoder {
  private output: Output;
  private target: BufferTarget;
  private video: CanvasSource;
  private audio: AudioBufferSource | null = null;
  private fps: number;

  constructor(opts: Mp4EncoderOpts) {
    this.fps = opts.fps;
    this.target = new BufferTarget();
    this.output = new Output({ format: new Mp4OutputFormat(), target: this.target });
    this.video = new CanvasSource(opts.canvas, { codec: opts.codec, bitrate: QUALITY_HIGH });
    this.output.addVideoTrack(this.video, { frameRate: opts.fps });
  }

  /** Add an AAC audio track. Must be called before start(). */
  addAudioTrack(): void {
    this.audio = new AudioBufferSource({ codec: 'aac', bitrate: QUALITY_HIGH });
    this.output.addAudioTrack(this.audio);
  }

  async start(): Promise<void> {
    await this.output.start();
  }

  /** Capture the current canvas pixels as frame `index` (timestamp = index/fps). Awaits backpressure. */
  async addFrame(index: number): Promise<void> {
    await this.video.add(index / this.fps, 1 / this.fps);
  }

  async addAudio(buffer: AudioBuffer): Promise<void> {
    if (!this.audio) throw new Error('Mp4Encoder: addAudioTrack() must be called before start()');
    await this.audio.add(buffer);
  }

  /** Finalize and return the MP4 Blob. */
  async finish(): Promise<Blob> {
    await this.output.finalize();
    const buf = this.target.buffer;
    if (!buf) throw new Error('Mp4Encoder: encoder produced no output');
    return new Blob([buf], { type: 'video/mp4' });
  }

  /** Abort an in-flight encode: releases the hardware VideoEncoder session and drops the
   *  in-RAM BufferTarget (the partial MP4). Safe after finalize/cancel (no-op). */
  async cancel(): Promise<void> {
    try {
      await this.output.cancel();
    } catch {
      /* already finalized or cancelled */
    }
  }
}

/**
 * Resolve the best available video codec for a resolution. Prefers H.265 only when
 * asked AND supported, else falls back to H.264. Returns null if neither encodes.
 * (Mediabunny's helper wraps VideoEncoder.isConfigSupported with the exact config it
 * will use, so it is more reliable than calling isConfigSupported directly.)
 */
export async function pickVideoCodec(
  prefer: VideoCodecChoice,
  width: number,
  height: number,
): Promise<VideoCodecChoice | null> {
  const order: VideoCodecChoice[] = prefer === 'hevc' ? ['hevc', 'avc'] : ['avc'];
  const codec = await getFirstEncodableVideoCodec(order, { width, height });
  return (codec as VideoCodecChoice | null) ?? null;
}

/** Whether this browser can export MP4 (WebCodecs present + an H.264 path + AAC) at a size. */
export async function canExportMp4(width: number, height: number): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  const v = await getFirstEncodableVideoCodec(['avc'], { width, height });
  const a = await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000 });
  return !!v && a;
}
