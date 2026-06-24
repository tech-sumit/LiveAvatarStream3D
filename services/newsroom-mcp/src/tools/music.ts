/**
 * Newsroom MCP — music tools (task NM-8, Phase 2 / Tier 2).
 *
 * `generate_music` synthesizes a parametric "breaking news" instrumental bed
 * (numpy via python3) and serves it as a WAV asset, ready to feed `post_produce`
 * as a music bed. Requires python3 + numpy.
 */

import { z } from 'zod';
import { defineTool, type ToolDef } from '../server.js';
import { assetUrl, registerAsset } from '../transport.js';
import { synthMusic } from '../assets/music.js';

const generateMusic = defineTool({
  name: 'generate_music',
  title: 'Synthesize a news music bed',
  description:
    'Synthesize a parametric "breaking news" instrumental (riser → impact → driving groove ' +
    'bed) as a 48 kHz stereo WAV via python3 + numpy, and serve it. Feed the result to ' +
    'post_produce as a music bed. Returns the WAV asset URL + local path. Requires python3 + numpy.',
  inputSchema: {
    mood: z
      .enum(['breaking', 'tense', 'calm', 'upbeat'])
      .optional()
      .describe('Overall character (intensity/brightness/duck). Default "breaking"'),
    tempoBpm: z
      .number()
      .int()
      .min(60)
      .max(200)
      .optional()
      .describe('Groove tempo in BPM. Default 120'),
    bars: z
      .number()
      .int()
      .min(1)
      .max(64)
      .optional()
      .describe('Number of groove bars after the impact. Default 6'),
    progression: z
      .array(z.enum(['Cm', 'Ab', 'Eb', 'Bb']))
      .optional()
      .describe("Chord progression (cycled to `bars`). Default ['Cm','Ab','Eb','Bb','Cm','Ab']"),
  },
  async handler({ mood, tempoBpm, bars, progression }) {
    try {
      const wav = await synthMusic({ mood, tempoBpm, bars, progression });
      registerAsset(wav);
      const url = assetUrl(wav);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, url, path: wav }) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to generate music: ${String(err)}` }],
        isError: true,
      };
    }
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const musicTools: ToolDef<any>[] = [generateMusic];
