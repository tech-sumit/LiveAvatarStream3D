import { WebSpeechTts } from '../tts/webSpeech.js';
import { ServerTts } from '../tts/serverTts.js';
import { ElevenLabsTts } from '../tts/elevenLabs.js';
import type { TtsSource } from '../tts/types.js';
import type { StudioContext } from './context.js';

/** TTS source selection (Web Speech → ElevenLabs upgrade) + the voice dropdown. */
export class VoicePicker {
  private serverTtsUrl = import.meta.env.VITE_TTS_URL as string | undefined;
  private _activeTts: TtsSource;
  // A project loaded before the voice list finished populating stashes its voice
  // here; populateVoices() applies it once the matching <option> exists.
  private pendingVoiceId: string | null = null;

  constructor(private app: StudioContext) {
    this._activeTts = WebSpeechTts.supported()
      ? new WebSpeechTts()
      : this.serverTtsUrl
        ? new ServerTts(this.serverTtsUrl)
        : new WebSpeechTts();
  }

  get activeTts(): TtsSource {
    return this._activeTts;
  }
  ttsOpts = () => ({
    voiceId: this.app.dom.voiceSel.value || undefined,
    rate: Number(this.app.dom.rateEl.value),
    pitch: Number(this.app.dom.pitchEl.value),
  });

  private voiceOptionExists(id: string): boolean {
    return [...this.app.dom.voiceSel.options].some((o) => o.value === id);
  }

  async populateVoices(): Promise<void> {
    const sel = this.app.dom.voiceSel;
    sel.innerHTML = '';
    if (!this._activeTts.listVoices) return;
    const voices = await this._activeTts.listVoices();
    for (const v of voices) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.label;
      sel.appendChild(opt);
    }
    // Default voice: ElevenLabs → "Sarah"; Web Speech → an English voice.
    if (this._activeTts.kind === 'web-speech') {
      const en = voices.find((v) => /en[-_]/i.test(v.id) || /English/i.test(v.label));
      if (en) sel.value = en.id;
    } else {
      const sarah = voices.find((v) => /\bsarah\b/i.test(v.label));
      if (sarah) sel.value = sarah.id;
    }
    if (this.pendingVoiceId && this.voiceOptionExists(this.pendingVoiceId)) {
      sel.value = this.pendingVoiceId;
      this.pendingVoiceId = null;
    }
  }

  serialize() {
    const d = this.app.dom;
    return { voiceId: d.voiceSel.value, rate: Number(d.rateEl.value), pitch: Number(d.pitchEl.value) };
  }
  apply(doc: { voiceId?: string; rate?: number; pitch?: number }): void {
    const d = this.app.dom;
    d.rateEl.value = String(doc.rate ?? 1);
    d.pitchEl.value = String(doc.pitch ?? 1);
    if (doc.voiceId) {
      if (this.voiceOptionExists(doc.voiceId)) d.voiceSel.value = doc.voiceId;
      else this.pendingVoiceId = doc.voiceId;
    }
  }

  async init(): Promise<void> {
    if (await ElevenLabsTts.available()) {
      this._activeTts = new ElevenLabsTts('/eleven', this.app.audio, () => this.app.recordDest);
      this.app.log('voice: ElevenLabs (real TTS) — lip-sync from the actual waveform');
    } else {
      this.app.log('voice: browser (Web Speech). Add ELEVENLABS_API_KEY to apps/avatar-live/.env for ElevenLabs.');
    }
    await this.populateVoices();
  }
}
