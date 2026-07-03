/**
 * Newsroom MCP — montage tools.
 *
 * `build_backscreen_montage` ffmpegs a list of broadcast cards (from the
 * graphics tools) into a silent 1920x1080 crossfade montage MP4 and serves it
 * as an asset. It does NOT load the studio wall itself — the caller applies the
 * returned URL via the studio's in-browser WebMCP `set_backscreen_media` tool
 * (the Studio Bridge push was retired; see
 * docs/specs/2026-06-25-webmcp-studio-control-design.md).
 */

import { z } from 'zod';
import { defineTool, type ToolDef } from '../server.js';
import { assetPath, assetUrl, registerAsset } from '../assets/serve.js';
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
  title: 'Build a back-screen montage MP4',
  description:
    'Stitch the given broadcast cards (asset URLs / ids / local paths, e.g. the output ' +
    'of generate_backscreen_cards) into a silent 1920x1080 crossfade montage MP4 and ' +
    'serve it. Returns the montage asset URL + local path; this tool does not touch the ' +
    "studio — apply the returned url yourself via the studio's WebMCP " +
    'set_backscreen_media tool to play it on the back wall. Requires ffmpeg.',
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
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              url,
              path: mp4,
              note:
                'Montage built and served. Apply it in the studio via the WebMCP ' +
                `set_backscreen_media tool with this url: ${url}`,
            }),
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
