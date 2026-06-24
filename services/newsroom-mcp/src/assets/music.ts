/**
 * Newsroom MCP — parametric news-music synth (task NM-8, Phase 2 / Tier 2).
 *
 * Synthesize a "breaking news" instrumental bed by spawning `python3` to run a
 * numpy synth ported from the proven session script (`/tmp/make_music.py`): a
 * riser → impact → driving groove bed with a detuned-saw chord progression,
 * sub bass, and a drum kit, written out as a 48 kHz stereo WAV.
 *
 * The Python program is generated at runtime (parameters are interpolated into a
 * heredoc-style source string), written to a temp `.py`, and executed. Throws a
 * clear error if `python3` / `numpy` are unavailable or the synth fails.
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { workDir } from '../transport.js';

export type MusicMood = 'breaking' | 'tense' | 'calm' | 'upbeat';

export interface MusicParams {
  /** Overall character. Affects intensity/brightness/duck. Default 'breaking'. */
  mood?: MusicMood;
  /** Groove tempo in BPM (drives beat spacing). Default 120. */
  tempoBpm?: number;
  /** Number of groove bars (chords) after the impact. Default 6. */
  bars?: number;
  /**
   * Chord progression as a list of roman-ish chord names from the supported set
   * (`Cm`, `Ab`, `Eb`, `Bb`). Default cycles `['Cm','Ab','Eb','Bb','Cm','Ab']`.
   */
  progression?: string[];
  /** Output basename (without extension) inside the work dir. */
  basename?: string;
}

const SUPPORTED_CHORDS = new Set(['Cm', 'Ab', 'Eb', 'Bb']);

/** Per-mood synth tuning: master gain, brightness (LP width), and groove duck. */
const MOOD_TUNING: Record<MusicMood, { gain: number; impact: number; duck: number }> = {
  breaking: { gain: 0.92, impact: 0.55, duck: 0.13 },
  tense: { gain: 0.88, impact: 0.5, duck: 0.1 },
  calm: { gain: 0.8, impact: 0.32, duck: 0.18 },
  upbeat: { gain: 0.95, impact: 0.6, duck: 0.08 },
};

/** Build the parametric Python synth source. */
function buildPythonSource(params: Required<Omit<MusicParams, 'basename'>>, outWav: string): string {
  const tuning = MOOD_TUNING[params.mood];
  const beat = 60 / params.tempoBpm; // seconds per beat
  const barLen = beat * 4; // 4-beat bars
  // Total = build (2.5s riser) + 0.5s lead-in + groove bars, +1s tail.
  const grooveLen = barLen * params.bars;
  const total = 2.5 + 0.5 + grooveLen + 1.0;
  const progJson = JSON.stringify(params.progression);

  return `#!/usr/bin/env python3
"""Parametric 'breaking news' instrumental: riser -> impact -> driving bed."""
import numpy as np, wave, json, sys

SR = 48000
TOTAL = ${total.toFixed(3)}
BEAT = ${beat.toFixed(5)}
BARLEN = ${barLen.toFixed(5)}
BARS = ${params.bars}
IMPACT_LVL = ${tuning.impact.toFixed(3)}
DUCK_STEP = ${tuning.duck.toFixed(3)}
MASTER = ${tuning.gain.toFixed(3)}
PROG_NAMES = json.loads(${JSON.stringify(progJson)})
buf = np.zeros(int(TOTAL * SR))

def tt(n):
    return np.arange(n) / SR

def add(sig, start):
    i = int(start * SR); j = min(len(buf), i + len(sig))
    if j > i:
        buf[i:j] += sig[: j - i]

def env_adsr(n, a, d, s_lvl, r):
    e = np.zeros(n); ai, di, ri = int(a*SR), int(d*SR), int(r*SR)
    si = max(0, n - ai - di - ri); k = 0
    if ai: e[:ai] = np.linspace(0, 1, ai); k = ai
    if di: e[k:k+di] = np.linspace(1, s_lvl, di); k += di
    e[k:k+si] = s_lvl; k += si
    if ri and k < n: m = min(n, k+ri); e[k:m] = np.linspace(s_lvl, 0, m-k)
    return e

def lp(x, width):
    k = np.hanning(max(3, width)); k /= k.sum()
    return np.convolve(x, k, mode="same")

def saw(freq, dur, detune=0.0):
    t = tt(int(dur*SR)); f = freq*(1+detune)
    return 2*(t*f - np.floor(0.5 + t*f))

def sine(freq, dur):
    t = tt(int(dur*SR)); return np.sin(2*np.pi*freq*t)

def pad(freqs, dur, lvl=0.16):
    n = int(dur*SR); s = np.zeros(n)
    for f in freqs:
        for dt in (-0.006, 0.006):
            ss = saw(f, dur, dt); s += ss[:n]
    s = lp(s, 220)
    return s * env_adsr(n, 0.25, 0.3, 0.85, 0.5) * (lvl/len(freqs))

def brass(freqs, dur, lvl=0.5):
    n = int(dur*SR); s = np.zeros(n)
    for f in freqs:
        for dt in (-0.01, 0.0, 0.01):
            ss = saw(f, dur, dt); s += ss[:n]
    s = lp(s, 60)
    return s * env_adsr(n, 0.01, 0.5, 0.45, dur*0.6) * (lvl/len(freqs))

def bass(freq, dur, lvl=0.5):
    n = int(dur*SR)
    s = sine(freq, dur) + 0.25*sine(freq*2, dur)
    return s * env_adsr(n, 0.01, 0.12, 0.7, 0.1) * lvl

def kick(lvl=0.95):
    dur = 0.32; n = int(dur*SR); t = tt(n)
    f = 120*np.exp(-t*22) + 46
    ph = 2*np.pi*np.cumsum(f)/SR
    s = np.sin(ph) * np.exp(-t*9)
    return s*lvl

def snare(lvl=0.4):
    dur = 0.22; n = int(dur*SR); t = tt(n)
    noise = np.random.uniform(-1, 1, n)
    noise = noise - lp(noise, 40)
    tone = 0.3*np.sin(2*np.pi*190*t)
    return (noise + tone) * np.exp(-t*16) * lvl

def hat(lvl=0.18):
    dur = 0.07; n = int(dur*SR); t = tt(n)
    noise = np.random.uniform(-1, 1, n); noise = noise - lp(noise, 12)
    return noise*np.exp(-t*60)*lvl

def crash(lvl=0.4):
    dur = 1.6; n = int(dur*SR); t = tt(n)
    noise = np.random.uniform(-1, 1, n); noise = noise - lp(noise, 8)
    return noise*np.exp(-t*3)*lvl

def riser(dur=2.5, lvl=0.4):
    n = int(dur*SR); t = tt(n)
    f = 180*np.exp(t/dur*np.log(2200/180))
    sweep = np.sin(2*np.pi*np.cumsum(f)/SR) * (t/dur)**2
    noise = np.random.uniform(-1, 1, n); noise = noise - lp(noise, 25)
    noise *= (t/dur)**2
    return (0.5*sweep + 0.5*noise) * lvl * np.hanning(n*2)[:n]

N = {"Ab1":51.91,"Bb1":58.27,"C2":65.41,"Eb2":77.78,"Ab2":103.83,"Bb2":116.54,
     "C3":130.81,"D3":146.83,"Eb3":155.56,"F3":174.61,"G3":196.0,"Ab3":207.65,
     "Bb3":233.08,"C4":261.63,"Eb4":311.13,"G4":392.0}
CHORDS = {
    "Cm": ([N["C3"],N["Eb3"],N["G3"]], N["C2"]),
    "Ab": ([N["Ab2"],N["C3"],N["Eb3"]], N["Ab1"]),
    "Eb": ([N["Eb3"],N["G3"],N["Bb3"]], N["Eb2"]),
    "Bb": ([N["Bb2"],N["D3"],N["F3"]], N["Bb1"]),
}

IMPACT = 2.5
# build
add(riser(2.5, 0.42), 0.0)
add(sine(48, 2.5)*np.linspace(0,0.4,int(2.5*SR))*0.5, 0.0)
for ti in (1.6, 2.0, 2.3, 2.45):
    add(kick(0.5), ti)
# impact
add(brass([N["C3"],N["Eb3"],N["G3"],N["C4"],N["Eb4"],N["G4"]], 1.4, IMPACT_LVL), IMPACT)
add(kick(1.0), IMPACT)
add(crash(0.45), IMPACT)
add(bass(N["C2"], 1.0, 0.6), IMPACT)
# groove bed: progression cycled to BARS, BARLEN per chord, softening over time
g0 = IMPACT + 0.5
for k in range(BARS):
    name = PROG_NAMES[k % len(PROG_NAMES)] if PROG_NAMES else "Cm"
    ch, root = CHORDS.get(name, CHORDS["Cm"])
    st = g0 + k*BARLEN
    if st >= TOTAL: break
    duck = max(0.25, 1.0 - k*DUCK_STEP)
    add(pad(ch, BARLEN, 0.18*duck), st)
    for b in range(4):
        bt = st + b*BEAT
        if bt >= TOTAL: break
        add(bass(root if b%2==0 else root*1.5, min(0.45, BEAT*0.9), 0.42*duck), bt)
        add(kick(0.8*duck), bt)
        add(hat(0.16*duck), bt+BEAT*0.5)
        if b == 2: add(snare(0.34*duck), bt)

def reverb(x):
    out = x.copy()
    for dly, dec in [(0.017,0.5),(0.031,0.4),(0.053,0.3),(0.089,0.22),(0.131,0.16)]:
        d = int(dly*SR); out[d:] += x[:-d]*dec
    return out
wet = reverb(buf)
mix = buf*0.8 + wet*0.25
fade_start = int((TOTAL-2.0)*SR)
if fade_start < len(mix):
    mix[fade_start:] *= np.linspace(1, 0, len(mix)-fade_start)
mix = np.tanh(mix*1.1)
mix /= np.max(np.abs(mix)) + 1e-9
mix *= MASTER
R = np.zeros_like(mix); d = int(0.012*SR); R[d:] = mix[:-d]
stereo = np.stack([mix, 0.85*mix + 0.3*R], axis=1)
stereo = (stereo * 32767).astype(np.int16)

OUT = ${JSON.stringify(outWav)}
with wave.open(OUT, "w") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(stereo.tobytes())
print("wrote", OUT, round(len(buf)/SR,2), "s")
`;
}

/**
 * Synthesize a news-music bed WAV. Spawns `python3` to run the numpy synth.
 *
 * @param params Mood / tempo / bars / progression overrides.
 * @returns The local path to the written 48 kHz stereo WAV (in the work dir).
 */
export async function synthMusic(params: MusicParams = {}): Promise<string> {
  const mood: MusicMood = params.mood ?? 'breaking';
  const tempoBpm = Math.max(60, Math.min(params.tempoBpm ?? 120, 200));
  const bars = Math.max(1, Math.min(params.bars ?? 6, 64));
  let progression = params.progression?.length
    ? params.progression
    : ['Cm', 'Ab', 'Eb', 'Bb', 'Cm', 'Ab'];
  const bad = progression.filter((c) => !SUPPORTED_CHORDS.has(c));
  if (bad.length) {
    throw new Error(
      `synthMusic: unsupported chord(s) ${bad.join(', ')}. Supported: ${[...SUPPORTED_CHORDS].join(', ')}.`,
    );
  }

  const base = params.basename ?? `music-${randomUUID().slice(0, 8)}`;
  const outWav = join(workDir(), `${base}.wav`);
  const pyPath = join(workDir(), `${base}.py`);
  const source = buildPythonSource({ mood, tempoBpm, bars, progression }, outWav);
  writeFileSync(pyPath, source);

  await runPython(pyPath);
  if (!existsSync(outWav)) {
    throw new Error('synthMusic: python reported success but no WAV file was written.');
  }
  return outWav;
}

/** Run the generated python synth; surface numpy-missing and other errors clearly. */
function runPython(scriptPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('python3', [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(
        new Error(`Failed to spawn python3 (is it installed and on PATH?): ${String(err)}`),
      );
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (err) => {
      reject(
        new Error(`python3 could not be started (is it installed and on PATH?): ${String(err)}`),
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      if (/ModuleNotFoundError|No module named ['"]?numpy/.test(stderr)) {
        reject(
          new Error(
            'synthMusic requires numpy. Install it with `pip3 install numpy` (or `python3 -m pip install numpy`).',
          ),
        );
        return;
      }
      reject(new Error(`python3 synth exited ${code}. stderr tail:\n${stderr.trim()}`));
    });
  });
}
