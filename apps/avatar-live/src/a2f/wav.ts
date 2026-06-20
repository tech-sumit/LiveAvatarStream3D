// Encode a decoded AudioBuffer to a 16 kHz mono 16-bit PCM WAV — the input format
// Audio2Face-3D expects. Used by the server client when posting audio to the NIM.
export function audioBufferToWav16kMono(buffer: AudioBuffer): ArrayBuffer {
  const targetRate = 16000;
  const mono = downmixToMono(buffer);
  const resampled = resampleLinear(mono, buffer.sampleRate, targetRate);
  return encodeWavPcm16(resampled, targetRate);
}

function downmixToMono(buffer: AudioBuffer): Float32Array {
  const ch = buffer.numberOfChannels;
  if (ch === 1) return buffer.getChannelData(0).slice();
  const len = buffer.length;
  const out = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i] / ch;
  }
  return out;
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = toRate / fromRate;
  const outLen = Math.round(input.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = src - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

function encodeWavPcm16(samples: Float32Array, rate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const w = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
