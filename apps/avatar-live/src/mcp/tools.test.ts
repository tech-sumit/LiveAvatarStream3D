import { describe, it, expect, vi } from 'vitest';
import { BRIDGE_TOOLS } from '@las/protocol';
import { buildStudioTools, type StudioToolDeps } from './tools.js';

function stubDeps(over: Partial<StudioToolDeps> = {}): StudioToolDeps {
  return {
    dispatch: vi.fn(async () => ({ ok: true })),
    screenshot: vi.fn(async () => ({ data: 'BASE64PNG', mimeType: 'image/png', width: 1920, height: 1080 })),
    exportVideo: vi.fn(async () => ({ bytes: 123, filename: 'demo.mp4' })),
    allowExecuteJs: false,
    ...over,
  };
}

const byName = (tools: ReturnType<typeof buildStudioTools>, name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

describe('buildStudioTools', () => {
  it('registers every command except execute_js by default', () => {
    const tools = buildStudioTools(stubDeps());
    expect(tools).toHaveLength(BRIDGE_TOOLS.length - 1);
    expect(tools.some((t) => t.name === 'execute_js')).toBe(false);
    // each tool carries the protocol schema + read-only hint
    const getState = byName(tools, 'get_state');
    expect(getState.annotations?.readOnlyHint).toBe(true);
    expect(getState.inputSchema).toBeTypeOf('object');
  });

  it('includes execute_js only when explicitly allowed', () => {
    const tools = buildStudioTools(stubDeps({ allowExecuteJs: true }));
    expect(tools).toHaveLength(BRIDGE_TOOLS.length);
    expect(tools.some((t) => t.name === 'execute_js')).toBe(true);
  });

  it('routes a mutating tool through dispatch and wraps the result as text', async () => {
    const deps = stubDeps({ dispatch: vi.fn(async () => ({ voiceId: 'abc' })) });
    const tools = buildStudioTools(deps);
    const res = await byName(tools, 'set_voice').execute({ voiceId: 'abc' });
    expect(deps.dispatch).toHaveBeenCalledWith('setVoice', { voiceId: 'abc' });
    expect(res.content).toEqual([{ type: 'text', text: JSON.stringify({ voiceId: 'abc' }) }]);
    expect(res.isError).toBeUndefined();
  });

  it('returns an inline image (+dims) for screenshot, not a dispatch call', async () => {
    const deps = stubDeps();
    const tools = buildStudioTools(deps);
    const res = await byName(tools, 'screenshot').execute({ target: 'viewport' });
    expect(deps.screenshot).toHaveBeenCalledWith({ target: 'viewport' });
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(res.content[0]).toEqual({ type: 'image', data: 'BASE64PNG', mimeType: 'image/png' });
    expect(res.content[1]).toEqual({ type: 'text', text: JSON.stringify({ width: 1920, height: 1080 }) });
  });

  it('routes export_mp4 through exportVideo and returns the metadata', async () => {
    const deps = stubDeps();
    const tools = buildStudioTools(deps);
    const res = await byName(tools, 'export_mp4').execute({});
    expect(deps.exportVideo).toHaveBeenCalledOnce();
    expect(res.content).toEqual([{ type: 'text', text: JSON.stringify({ bytes: 123, filename: 'demo.mp4' }) }]);
  });

  it('surfaces a handler error as an isError text result', async () => {
    const deps = stubDeps({
      dispatch: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const tools = buildStudioTools(deps);
    const res = await byName(tools, 'set_script').execute({ script: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: 'text', text: 'boom' }]);
  });

  it('validates input against the protocol zod params before dispatching', async () => {
    const deps = stubDeps();
    const tools = buildStudioTools(deps);
    // rate 10 is out of the 0.5–2 range; set_backscreen_media{} satisfies neither union branch;
    // emotion must be an enum member. All must be rejected without reaching the dispatcher.
    for (const [name, bad] of [
      ['set_voice', { voiceId: 'v', rate: 10 }],
      ['set_backscreen_media', {}],
      ['set_emotion', { emotion: 'bogus' }],
      ['add_cue', { track: 'camera', type: 'x', start: -5 }],
    ] as const) {
      const res = await byName(tools, name).execute(bad);
      expect(res.isError, `${name} should reject ${JSON.stringify(bad)}`).toBe(true);
    }
    expect(deps.dispatch).not.toHaveBeenCalled();

    // a valid call passes the parsed params through
    await byName(tools, 'set_voice').execute({ voiceId: 'v', rate: 1.5 });
    expect(deps.dispatch).toHaveBeenCalledWith('setVoice', { voiceId: 'v', rate: 1.5 });
  });
});
