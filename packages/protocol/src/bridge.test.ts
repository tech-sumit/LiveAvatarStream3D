import { describe, it, expect } from 'vitest';
import {
  BridgeCommand,
  BridgeRequest,
  BridgeResult,
  BridgeRegister,
  BRIDGE_COMMANDS,
  parseBridgeCommand,
  bridgeOk,
  bridgeError,
  type BridgeCommandName,
} from './bridge.js';

/** One representative valid sample per command `cmd`. */
const SAMPLES: Record<BridgeCommandName, unknown> = {
  applyNewscast: { cmd: 'applyNewscast', params: { doc: { version: 2, anything: true } } },
  patchNewscast: { cmd: 'patchNewscast', params: { patch: { meta: { title: 'x' } } } },
  validateNewscast: { cmd: 'validateNewscast', params: { doc: { version: 2 } } },
  setScript: { cmd: 'setScript', params: { script: 'Good evening. [warm] Tonight...' } },
  setVoice: { cmd: 'setVoice', params: { voiceId: 'vox_123', rate: 1.1, pitch: 0.95 } },
  setAvatar: { cmd: 'setAvatar', params: { avatar: 'avaturn-model' } },
  setEmotion: { cmd: 'setEmotion', params: { emotion: 'serious' } },
  setLighting: { cmd: 'setLighting', params: { preset: 'dramatic', warmth: 60 } },
  setLook: { cmd: 'setLook', params: { preset: 'cinematic', bloom: 0.4, contrast: 0.1 } },
  setCaptureFormat: { cmd: 'setCaptureFormat', params: { resolution: '1080p', codec: 'avc' } },
  addCue: { cmd: 'addCue', params: { track: 'camera', type: 'dolly_in', start: 0, duration: 2 } },
  updateCue: { cmd: 'updateCue', params: { id: 'cue_1', start: 1.5 } },
  removeCue: { cmd: 'removeCue', params: { id: 'cue_1' } },
  listCues: { cmd: 'listCues', params: {} },
  captureView: { cmd: 'captureView', params: { label: 'over the shoulder' } },
  setTimelineLength: { cmd: 'setTimelineLength', params: { seconds: 30 } },
  clearTimeline: { cmd: 'clearTimeline', params: {} },
  setHeadline: { cmd: 'setHeadline', params: { text: 'BREAKING NEWS' } },
  setBackscreenMedia: { cmd: 'setBackscreenMedia', params: { url: 'https://x/y.mp4' } },
  getState: { cmd: 'getState', params: {} },
  screenshot: { cmd: 'screenshot', params: { target: 'viewport', seek: 4.2 } },
  preview: { cmd: 'preview', params: {} },
  exportMp4: { cmd: 'exportMp4', params: {} },
  executeJs: { cmd: 'executeJs', params: { code: 'studio.stage.setHeadline("hi")' } },
};

describe('BridgeCommand', () => {
  it('has a sample covering every declared command', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...BRIDGE_COMMANDS].sort());
  });

  for (const cmd of BRIDGE_COMMANDS) {
    it(`parses a sample ${cmd} command`, () => {
      const sample = SAMPLES[cmd];
      expect(() => BridgeCommand.parse(sample)).not.toThrow();
      const parsed = parseBridgeCommand(sample);
      expect(parsed.cmd).toBe(cmd);
    });
  }

  it('accepts setBackscreenMedia clear variant', () => {
    expect(() =>
      BridgeCommand.parse({ cmd: 'setBackscreenMedia', params: { clear: true } }),
    ).not.toThrow();
  });

  it('accepts setLighting explicit channels (no preset)', () => {
    expect(() =>
      BridgeCommand.parse({ cmd: 'setLighting', params: { key: 1.6, fill: 0.4, rim: 0.6, ambient: 0.45, exposure: 1.05, warmth: 55 } }),
    ).not.toThrow();
  });

  it('rejects an unknown command', () => {
    expect(() => BridgeCommand.parse({ cmd: 'nope', params: {} })).toThrow();
  });

  it('rejects a bad scalar (rate out of range)', () => {
    expect(() => BridgeCommand.parse({ cmd: 'setVoice', params: { voiceId: 'v', rate: 9 } })).toThrow();
  });
});

describe('BridgeRequest', () => {
  it('parses a command carrying a correlation id', () => {
    const req = { id: 'req_1', cmd: 'setEmotion', params: { emotion: 'happy' } };
    expect(() => BridgeRequest.parse(req)).not.toThrow();
  });
});

describe('BridgeResult', () => {
  it('parses an ok result with a payload', () => {
    expect(() => BridgeResult.parse(bridgeOk('req_1', { cues: [] }))).not.toThrow();
    expect(() => BridgeResult.parse({ id: 'r', ok: true })).not.toThrow();
  });

  it('parses an error result', () => {
    const err = bridgeError('req_2', 'no studio connected');
    expect(() => BridgeResult.parse(err)).not.toThrow();
    expect(err.ok).toBe(false);
  });

  it('rejects an ok result missing the literal', () => {
    expect(() => BridgeResult.parse({ id: 'r', result: {} })).toThrow();
  });
});

describe('BridgeRegister', () => {
  it('parses the connect handshake', () => {
    expect(() =>
      BridgeRegister.parse({ type: 'register', studioId: 'studio_A', capabilities: ['exportMp4'] }),
    ).not.toThrow();
  });
});
