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
      // either a plain object schema or a union (setBackscreenMedia → anyOf)
      const hasShape = t.inputSchema.type === 'object' || Array.isArray(t.inputSchema.anyOf);
      expect(hasShape).toBe(true);
    }
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

  it('read-only hints flag the non-mutating tools', () => {
    const readOnly = new Set(BRIDGE_TOOLS.filter((t) => t.readOnly).map((t) => t.cmd));
    expect(readOnly).toEqual(new Set(['validateNewscast', 'listCues', 'getState', 'screenshot']));
  });
});
