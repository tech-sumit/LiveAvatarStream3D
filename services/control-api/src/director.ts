import {
  buildDirectorSystemPrompt,
  parseScript,
  type Script,
  type ScriptSegment,
} from '@las/protocol';
import type { Env } from './env.js';

/**
 * Director LLM client. Default provider is Anthropic (Claude Opus 4.8), behind
 * a small interface so it is swappable. Used in two modes:
 *  - draft: produce a full Script from a plain prompt.
 *  - stream: yields DSL segments as raw text chunks for incremental consumers.
 */
export interface DirectorLLM {
  draft(prompt: string, persona: string, language: string): Promise<Script>;
  /** Streaming JSONL of segments; yields raw text chunks. */
  streamRaw(systemPrompt: string, userTurn: string, history: { role: string; text: string }[]): AsyncGenerator<string>;
}

class AnthropicDirector implements DirectorLLM {
  constructor(
    private apiKey: string,
    private model: string,
  ) {}

  async draft(prompt: string, persona: string, language: string): Promise<Script> {
    const system = buildDirectorSystemPrompt(persona);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        system,
        messages: [
          {
            role: 'user',
            content: `Language: ${language}. Write the avatar's lines for: ${prompt}`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`director draft failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    const text = data.content.map((c) => c.text ?? '').join('');
    return jsonlToScript(text, language);
  }

  async *streamRaw(
    systemPrompt: string,
    userTurn: string,
    history: { role: string; text: string }[],
  ): AsyncGenerator<string> {
    const messages = [
      ...history.map((h) => ({ role: h.role === 'avatar' ? 'assistant' : 'user', text: h.text })),
      { role: 'user', text: userTurn },
    ].map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text }));

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: this.model, max_tokens: 1024, system: systemPrompt, stream: true, messages }),
    });
    if (!res.ok || !res.body) throw new Error(`director stream failed: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const evt = JSON.parse(line.slice(5).trim());
          if (evt.type === 'content_block_delta' && evt.delta?.text) {
            yield evt.delta.text as string;
          }
        } catch {
          /* keep-alive / non-JSON line */
        }
      }
    }
  }
}

/**
 * OpenRouter director (OpenAI-compatible chat completions). Used to serve Claude
 * via OpenRouter. The bearer token is stored in env.ANTHROPIC_API_KEY (the
 * OpenRouter key was placed there to reuse the existing secret).
 */
class OpenRouterDirector implements DirectorLLM {
  constructor(
    private apiKey: string,
    private model: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'https://las-web-3o1.pages.dev',
      'X-Title': 'LiveAvatarStream',
    };
  }

  async draft(prompt: string, persona: string, language: string): Promise<Script> {
    const system = buildDirectorSystemPrompt(persona);
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Language: ${language}. Write the avatar's lines for: ${prompt}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`director draft failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { choices: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content ?? '';
    return jsonlToScript(text, language);
  }

  async *streamRaw(
    systemPrompt: string,
    userTurn: string,
    history: { role: string; text: string }[],
  ): AsyncGenerator<string> {
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...history.map((h) => ({
        role: (h.role === 'avatar' ? 'assistant' : 'user') as 'assistant' | 'user',
        content: h.text,
      })),
      { role: 'user' as const, content: userTurn },
    ];

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model: this.model, max_tokens: 1024, stream: true, messages }),
    });
    if (!res.ok || !res.body) throw new Error(`director stream failed: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const evt = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
          const delta = evt.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          /* keep-alive / non-JSON line */
        }
      }
    }
  }
}

/** Parse loose JSONL (one segment per line) into a validated Script. */
export function jsonlToScript(text: string, language: string): Script {
  const segments: ScriptSegment[] = [];
  let seq = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^```(json)?|```$/g, '').trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      obj.seq = obj.seq ?? seq;
      segments.push(obj);
      seq++;
    } catch {
      /* skip malformed line */
    }
  }
  return parseScript({ version: 1, language, segments: segments.length ? segments : [{ seq: 0, text: text.trim() || '...' }] });
}

export function makeDirector(env: Env): DirectorLLM {
  if (env.DIRECTOR_LLM_PROVIDER === 'openrouter') {
    // OpenRouter key is stored in ANTHROPIC_API_KEY to reuse the existing secret.
    return new OpenRouterDirector(env.ANTHROPIC_API_KEY, env.DIRECTOR_LLM_MODEL || 'anthropic/claude-opus-4.8');
  }
  return new AnthropicDirector(env.ANTHROPIC_API_KEY, env.DIRECTOR_LLM_MODEL || 'claude-opus-4-8');
}
