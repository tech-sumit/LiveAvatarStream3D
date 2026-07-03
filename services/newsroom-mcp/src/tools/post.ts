/**
 * Newsroom MCP — post-production tools (task NM-8, Phase 2 / Tier 2).
 *
 * `post_produce` finishes a rendered newscast MP4: optional intro title card
 * (held + zoomed), a music bed (full over intro, ducked under narration, fade
 * out), optional lower-third overlays, concatenated into a final MP4 served as an
 * asset. Requires ffmpeg.
 */

import { z } from 'zod';
import { defineTool, type ToolDef } from '../server.js';
import { assetPath, assetUrl, registerAsset } from '../assets/serve.js';
import { postProduce, type LowerThird } from '../assets/post.js';

/** Resolve a media ref (asset id, registered path, /asset/<id> URL, or local path). */
function resolvePath(ref: string): string {
  const direct = assetPath(ref);
  if (direct) return direct;
  const m = ref.match(/\/asset\/([^/?#]+)/);
  if (m) {
    const viaUrl = assetPath(decodeURIComponent(m[1]!));
    if (viaUrl) return viaUrl;
  }
  return ref;
}

const lowerThirdSchema = z.object({
  path: z.string().min(1).describe('Lower-third overlay ref (asset URL/id or local PNG path)'),
  start: z.number().min(0).optional().describe('Show from this time (s, body timeline). Default 0'),
  end: z.number().min(0).optional().describe('Hide at this time (s). Default start+5'),
});

const postProduceTool = defineTool({
  name: 'post_produce',
  title: 'Post-produce a newscast MP4',
  description:
    'Finish a rendered newscast MP4: optional intro title card (held + slow zoom), a music ' +
    'bed (full over the intro, ducked under narration, faded out), optional lower-third ' +
    'overlays, concatenated into a final MP4. Returns the output asset URL + local path. ' +
    'Requires ffmpeg.',
  inputSchema: {
    inputMp4: z.string().min(1).describe('Source newscast MP4 (asset URL/id or local path)'),
    introCard: z
      .string()
      .min(1)
      .optional()
      .describe('Intro title-card PNG (asset URL/id or local path) — held + zoomed before the body'),
    introSeconds: z.number().positive().optional().describe('Seconds to hold the intro card. Default 4'),
    musicWav: z
      .string()
      .min(1)
      .optional()
      .describe('Music-bed WAV/MP3 (asset URL/id or local path) — e.g. generate_music output'),
    lowerThirds: z.array(lowerThirdSchema).optional().describe('Lower-third overlays on the body'),
  },
  async handler({ inputMp4, introCard, introSeconds, musicWav, lowerThirds }) {
    try {
      const lts: LowerThird[] | undefined = lowerThirds?.map((lt) => ({
        path: resolvePath(lt.path),
        start: lt.start,
        end: lt.end,
      }));
      const out = await postProduce(resolvePath(inputMp4), {
        introCard: introCard ? resolvePath(introCard) : undefined,
        introSeconds,
        musicWav: musicWav ? resolvePath(musicWav) : undefined,
        lowerThirds: lts,
      });
      registerAsset(out);
      const url = assetUrl(out);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, url, path: out }) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to post-produce: ${String(err)}` }],
        isError: true,
      };
    }
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const postTools: ToolDef<any>[] = [postProduceTool];
