/**
 * Newsroom MCP — montage tools (task NM-8, Phase 2 / Tier 2).
 *
 * `build_backscreen_montage` ffmpegs a list of broadcast cards (from NM-7's
 * graphics tools) into a silent 1920x1080 crossfade montage MP4, serves it as an
 * asset, AND loads it onto the studio back-wall via `setBackscreenMedia` so it
 * plays live behind the anchor.
 */

import { z } from 'zod';
import { defineTool, type ToolDef } from '../server.js';
import { assetPath, assetUrl, callBridge, registerAsset } from '../transport.js';
import { buildMontage } from '../assets/montage.js';

/** Resolve a card ref (asset id, registered path, or bare local path) to a local path. */
function resolveCardPath(ref: string): string {
  // assetPath handles a known asset id or a registered path; otherwise treat the
  // ref as a local path (or strip an /asset/<id> URL down to its id and retry).
  const direct = assetPath(ref);
  if (direct) return direct;
  const m = ref.match(/\/asset\/([^/?#]+)/);
  if (m) {
    const viaUrl = assetPath(decodeURIComponent(m[1]!));
    if (viaUrl) return viaUrl;
  }
  return ref;
}

const buildBackscreenMontage = defineTool({
  name: 'build_backscreen_montage',
  title: 'Build a back-screen montage and load it on the studio wall',
  description:
    'Stitch the given broadcast cards (asset URLs / ids / local paths, e.g. the output ' +
    'of generate_backscreen_cards) into a silent 1920x1080 crossfade montage MP4, serve ' +
    'it, and load it onto the studio back-wall via setBackscreenMedia so it plays live ' +
    'behind the anchor. Returns the montage asset URL + local path. Requires ffmpeg.',
  inputSchema: {
    cards: z
      .array(z.string().min(1))
      .min(1)
      .describe('Ordered card refs: asset URLs, asset ids, or local PNG paths'),
    perCardSeconds: z
      .number()
      .positive()
      .optional()
      .describe('Seconds each card holds (incl. crossfade). Default 5.5'),
    crossfadeSeconds: z
      .number()
      .positive()
      .optional()
      .describe('Crossfade duration between cards (seconds). Default 1.0'),
  },
  async handler({ cards, perCardSeconds, crossfadeSeconds }) {
    try {
      const paths = cards.map((c) => resolveCardPath(c));
      const mp4 = await buildMontage(paths, { perCardSeconds, crossfadeSeconds });
      registerAsset(mp4);
      const url = assetUrl(mp4);

      let wallLoaded = false;
      let wallNote = '';
      try {
        await callBridge('setBackscreenMedia', { url });
        wallLoaded = true;
        wallNote = 'Loaded live on the studio back-wall.';
      } catch (err) {
        wallNote = `Montage built but not loaded on the wall (no studio connected?): ${String(err)}`;
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, url, path: mp4, wallLoaded, note: wallNote }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to build montage: ${String(err)}` }],
        isError: true,
      };
    }
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const montageTools: ToolDef<any>[] = [buildBackscreenMontage];
