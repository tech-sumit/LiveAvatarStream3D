import { z } from 'zod';

export const VoiceStatus = z.enum(['pending', 'cloning', 'ready', 'failed']);
export type VoiceStatus = z.infer<typeof VoiceStatus>;

/** TTS engine selection. Streaming engines are used for realtime. */
export const TtsEngine = z.enum([
  'fish_s2', // quality, offline default
  'cosyvoice2', // streaming default
  'xtts_v2', // streaming alternate
  'chatterbox', // streaming alternate
  'f5_tts', // CC-BY-NC, off by default
]);
export type TtsEngine = z.infer<typeof TtsEngine>;

export const VoiceProfile = z.object({
  id: z.string(),
  userId: z.string(),
  label: z.string().default('Untitled voice'),
  status: VoiceStatus,
  engine: TtsEngine.default('fish_s2'),
  r2Prefix: z.string(),
  language: z.string().default('en'),
  createdAt: z.number().int(),
});
export type VoiceProfile = z.infer<typeof VoiceProfile>;

export const CloneVoiceRequest = z.object({
  userId: z.string(),
  label: z.string().optional(),
  /** R2 key of the uploaded 10-30s voice sample. */
  sampleKey: z.string(),
  engine: TtsEngine.default('fish_s2'),
  language: z.string().default('en'),
});
export type CloneVoiceRequest = z.infer<typeof CloneVoiceRequest>;
