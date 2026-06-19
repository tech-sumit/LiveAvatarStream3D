import type { TtsEngine } from './voice.js';

/** Built-in TTS engine presets shown when no cloned voices exist yet. */
export interface VoiceEnginePreset {
  engine: TtsEngine;
  label: string;
  description: string;
  /** Recommended for cinematic / engine_render jobs. */
  recommended?: boolean;
}

export const VOICE_ENGINE_PRESETS: VoiceEnginePreset[] = [
  {
    engine: 'fish_s2',
    label: 'Fish Audio S2',
    description: 'Highest quality — best for offline cinematic renders',
    recommended: true,
  },
  {
    engine: 'xtts_v2',
    label: 'XTTS v2',
    description: 'Fast clone from a short sample — good for lip-sync tests',
    recommended: true,
  },
  {
    engine: 'cosyvoice2',
    label: 'CosyVoice 2',
    description: 'Low-latency streaming voice',
  },
  {
    engine: 'chatterbox',
    label: 'Chatterbox Turbo',
    description: 'Expressive streaming alternate',
  },
];

export function presetForEngine(engine: TtsEngine): VoiceEnginePreset | undefined {
  return VOICE_ENGINE_PRESETS.find((p) => p.engine === engine);
}
