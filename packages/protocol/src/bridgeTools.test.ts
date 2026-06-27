import { describe, it, expect } from 'vitest';
import { BRIDGE_TOOLS, BRIDGE_COMMANDS, BRIDGE_PARAM_SCHEMAS } from './index.js';

describe('BRIDGE_TOOLS — WebMCP tool manifest', () => {
  it('exposes every bridge command exactly once (bijection with BRIDGE_COMMANDS)', () => {
    const toolCmds = BRIDGE_TOOLS.map((t) => t.cmd).sort();
    const commands = [...BRIDGE_COMMANDS].sort();
    expect(toolCmds).toEqual(commands);
    // no command exposed twice
    expect(new Set(toolCmds).size).toBe(BRIDGE_COMMANDS.length);
  });

  it('names are unique, snake_case, and derived from the command', () => {
    const names = BRIDGE_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of BRIDGE_TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    // spot-check the snake_case derivation
    const byCmd = Object.fromEntries(BRIDGE_TOOLS.map((t) => [t.cmd, t.name]));
    expect(byCmd.applyNewscast).toBe('apply_newscast');
    expect(byCmd.getState).toBe('get_state');
    expect(byCmd.exportMp4).toBe('export_mp4');
    expect(byCmd.executeJs).toBe('execute_js');
    expect(byCmd.setBackscreenMedia).toBe('set_backscreen_media');
  });

  it('every tool carries an object/anyOf JSON-Schema and a description', () => {
    for (const t of BRIDGE_TOOLS) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeTypeOf('object');
      // no leftover $schema key
      expect('$schema' in t.inputSchema).toBe(false);
      // EVERY tool advertises a JSON-Schema object (no bare top-level anyOf — strict MCP
      // clients require type:object; the union for set_backscreen_media is flattened).
      expect(t.inputSchema.type).toBe('object');
      expect('anyOf' in t.inputSchema).toBe(false);
    }
  });

  it('flattens the set_backscreen_media union into one object schema (url + clear)', () => {
    const tool = BRIDGE_TOOLS.find((t) => t.cmd === 'setBackscreenMedia');
    if (!tool) throw new Error('no set_backscreen_media tool');
    const schema = tool.inputSchema as { type?: string; properties?: Record<string, unknown> };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['clear', 'url']);
  });

  it('input schemas match the source zod params (required fields present)', () => {
    const schemaFor = (cmd: string) => {
      const tool = BRIDGE_TOOLS.find((t) => t.cmd === cmd);
      if (!tool) throw new Error(`no tool for ${cmd}`);
      return tool.inputSchema as { required?: string[] };
    };
    // setVoice requires voiceId
    expect(schemaFor('setVoice').required).toContain('voiceId');
    // addCue requires track/type/start
    expect(schemaFor('addCue').required).toEqual(expect.arrayContaining(['track', 'type', 'start']));
    // the param-schema map is complete too
    expect(Object.keys(BRIDGE_PARAM_SCHEMAS).sort()).toEqual([...BRIDGE_COMMANDS].sort());
  });

  it('read-only hints flag the non-mutating tools (screenshot is NOT read-only — seek moves the playhead)', () => {
    const readOnly = new Set(BRIDGE_TOOLS.filter((t) => t.readOnly).map((t) => t.cmd));
    expect(readOnly).toEqual(new Set(['validateNewscast', 'listCues', 'getState']));
    expect(readOnly.has('screenshot')).toBe(false);
  });
});
