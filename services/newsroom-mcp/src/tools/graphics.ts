/**
 * Newsroom MCP — graphics tools (task NM-7, Phase 2).
 *
 * Render broadcast back-wall cards with node-canvas and serve them to the
 * browser studio. `generate_graphics` renders an explicit list of card specs;
 * `generate_backscreen_cards` derives a standard breaking/what/why/numbers/
 * quote/developing set from a story's fields. Both write PNGs into the transport
 * work dir, register them as served assets, and return their asset URLs (ready
 * to feed `build_backscreen_montage` in NM-8) alongside the local paths.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool, type ToolDef } from '../server.js';
import { assetUrl, registerAsset, workDir } from '../transport.js';
import { renderCard, type CardSpec } from '../assets/cards.js';

// ---------------------------------------------------------------------------
// Input schema (mirrors CardSpec).
// ---------------------------------------------------------------------------

const cardSpecSchema = z.object({
  kind: z
    .enum(['title', 'lower_third', 'stat', 'quote', 'developing'])
    .describe('Card layout family'),
  pill: z.string().optional().describe('Kicker pill text (e.g. "BREAKING")'),
  pillColor: z.string().optional().describe("Pill color: a name ('blue'|'teal'|'red') or hex"),
  headline: z.string().describe('The big headline'),
  sub: z.string().optional().describe('Optional secondary line under the headline'),
  lowerThird: z.string().optional().describe('Optional lower-third kicker text'),
  accent: z.string().optional().describe('Accent underline color: a name or hex'),
});

interface RenderedCard {
  kind: string;
  url: string;
  path: string;
}

/** Render one spec, write it to the work dir, register + return its served URL. */
function renderAndServe(spec: CardSpec, basename: string): RenderedCard {
  const png = renderCard(spec);
  const path = join(workDir(), `${basename}.png`);
  writeFileSync(path, png);
  registerAsset(path);
  return { kind: spec.kind, url: assetUrl(path), path };
}

// ---------------------------------------------------------------------------
// generate_graphics — render an explicit list of cards.
// ---------------------------------------------------------------------------

const generateGraphics = defineTool({
  name: 'generate_graphics',
  title: 'Render broadcast graphic cards',
  description:
    'Render a list of broadcast back-wall cards (1920x1080 PNGs, dark-navy theme) ' +
    'and serve them to the studio. Returns each card\'s served asset URL and local path.',
  inputSchema: {
    cards: z.array(cardSpecSchema).min(1).describe('The card specs to render'),
  },
  async handler({ cards }) {
    try {
      const batch = randomUUID().slice(0, 8);
      const rendered = cards.map((spec, i) =>
        renderAndServe(spec as CardSpec, `card-${batch}-${i + 1}`),
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, cards: rendered }) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to render graphics: ${String(err)}` }],
        isError: true,
      };
    }
  },
});

// ---------------------------------------------------------------------------
// generate_backscreen_cards — derive a standard set from a story.
// ---------------------------------------------------------------------------

/** Build the standard breaking/what/why/numbers/quote/developing card set. */
function deriveStandardCards(story: {
  headline: string;
  what: string;
  why: string;
  numbers?: string;
  quote?: string;
}): CardSpec[] {
  const cards: CardSpec[] = [
    {
      kind: 'title',
      pill: 'BREAKING',
      pillColor: 'red',
      headline: story.headline,
      lowerThird: story.what,
      accent: 'blue',
    },
    {
      kind: 'lower_third',
      pill: 'THE STORY',
      pillColor: 'blue',
      headline: story.what,
      lowerThird: 'What happened',
      accent: 'teal',
    },
    {
      kind: 'lower_third',
      pill: 'WHY',
      pillColor: 'red',
      headline: story.why,
      lowerThird: 'Why it matters',
      accent: 'red',
    },
  ];
  if (story.numbers) {
    cards.push({
      kind: 'stat',
      pill: 'BY THE NUMBERS',
      pillColor: 'blue',
      headline: story.numbers,
      lowerThird: 'The figures',
      accent: 'teal',
    });
  }
  if (story.quote) {
    cards.push({
      kind: 'quote',
      pill: 'IN THEIR WORDS',
      pillColor: 'blue',
      headline: story.quote,
      lowerThird: 'On the record',
      accent: 'blue',
    });
  }
  cards.push({
    kind: 'developing',
    pill: 'DEVELOPING STORY',
    pillColor: 'red',
    headline: 'More to come',
    sub: 'We will keep following this story as it unfolds.',
    lowerThird: 'Stay with SUVI AI News',
    accent: 'blue',
  });
  return cards;
}

const generateBackscreenCards = defineTool({
  name: 'generate_backscreen_cards',
  title: 'Generate a standard back-screen card set from a story',
  description:
    'Derive and render a standard broadcast card set (breaking / what / why / numbers / ' +
    'quote / developing) from a story\'s fields, and serve them. Returns the ordered ' +
    'served asset URLs (ready to feed build_backscreen_montage) and local paths.',
  inputSchema: {
    headline: z.string().describe('The breaking headline'),
    what: z.string().describe('What happened (the story)'),
    why: z.string().describe('Why it matters'),
    numbers: z.string().optional().describe('Key figures / by-the-numbers line'),
    quote: z.string().optional().describe('A quote, in their words'),
  },
  async handler({ headline, what, why, numbers, quote }) {
    try {
      const specs = deriveStandardCards({ headline, what, why, numbers, quote });
      const batch = randomUUID().slice(0, 8);
      const rendered = specs.map((spec, i) =>
        renderAndServe(spec, `backscreen-${batch}-${i + 1}-${spec.kind}`),
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, cards: rendered, urls: rendered.map((r) => r.url) }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: 'text' as const, text: `Failed to generate back-screen cards: ${String(err)}` },
        ],
        isError: true,
      };
    }
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const graphicsTools: ToolDef<any>[] = [generateGraphics, generateBackscreenCards];
