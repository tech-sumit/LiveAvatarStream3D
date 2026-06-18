import { Hono } from 'hono';
import type { Env } from '../env.js';
import { makeDirector } from '../director.js';

export const director = new Hono<{ Bindings: Env }>();

/** Offline LLM-assist: draft a full DSL script from a plain prompt. */
director.post('/api/director/draft', async (c) => {
  const { prompt, persona, language } = await c.req.json<{
    prompt: string;
    persona?: string;
    language?: string;
  }>();
  const d = makeDirector(c.env);
  const script = await d.draft(prompt, persona ?? '', language ?? 'en');
  return c.json(script);
});
