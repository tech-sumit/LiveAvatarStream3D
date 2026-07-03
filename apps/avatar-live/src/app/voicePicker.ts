import { WebSpeechTts } from '../tts/webSpeech.js';
import { ServerTts } from '../tts/serverTts.js';
import { ElevenLabsTts } from '../tts/elevenLabs.js';
import { KokoroTts, subscribeKokoroProgress } from '../tts/kokoro.js';
import type { TtsSource } from '../tts/types.js';
import type { StudioContext } from './context.js';

/**
 * TTS source selection + the voice dropdown. Default is ElevenLabs (cloned voices),
 * with a key box to set an ElevenLabs key. Kokoro (free, in-browser, real PCM → MP4
 * export) is available from the Provider dropdown but gated behind a consent box —
 * picking it prompts before the one-time ~90 MB model download; on cancel we stay on
 * ElevenLabs. Override the initial provider with VITE_TTS_PROVIDER (kokoro |
 * elevenlabs | webspeech) or VITE_TTS_URL (a self-hosted server model).
 */
export class VoicePicker {
  private serverTtsUrl = import.meta.env.VITE_TTS_URL as string | undefined;
  private ttsPref = (import.meta.env.VITE_TTS_PROVIDER as string | undefined)?.toLowerCase();
  private _activeTts: TtsSource;
  // A project loaded before the voice list finished populating stashes its voice
  // here; populateVoices() applies it once the matching <option> exists.
  private pendingVoiceId: string | null = null;
  private kokoroProgUnsub: (() => void) | null = null;

  constructor(private app: StudioContext) {
    // Sensible synchronous default; init() resolves the real provider (default ElevenLabs).
    this._activeTts = this.serverTtsUrl
      ? new ServerTts(this.serverTtsUrl)
      : this.ttsPref === 'webspeech' && WebSpeechTts.supported()
        ? new WebSpeechTts()
        : this.ttsPref === 'kokoro'
          ? this.makeKokoro()
          : new ElevenLabsTts('/eleven', this.app.audio, () => this.app.recordDest);
  }

  /** Free in-browser Kokoro, wired to the shared audio ctx + recording tap + studio log. */
  private makeKokoro(): KokoroTts {
    return new KokoroTts(this.app.audio, () => this.app.recordDest, this.app.log);
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
    // Default voice: Kokoro → "Heart"; ElevenLabs → "Sarah"; Web Speech → English.
    if (this._activeTts.kind === 'web-speech') {
      const en = voices.find((v) => /en[-_]/i.test(v.id) || /English/i.test(v.label));
      if (en) sel.value = en.id;
    } else if (this._activeTts.kind === 'kokoro') {
      const heart = voices.find((v) => v.id === 'af_heart');
      if (heart) sel.value = heart.id;
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
    // The Provider dropdown drives Kokoro ↔ ElevenLabs at runtime. When a server /
    // web-speech env override is active it governs instead, so hide the dropdown.
    const sel = this.app.dom.ttsProviderSel;
    if (this.serverTtsUrl || this.ttsPref === 'webspeech') {
      if (sel) sel.hidden = true;
      await this.populateVoices();
      return;
    }
    // Picking Kokoro is gated by a consent box (one-time ~90 MB download); ElevenLabs
    // switches immediately.
    if (sel)
      sel.onchange = () => {
        if (sel.value === 'kokoro') this.askKokoroConsent();
        else void this.selectProvider('elevenlabs');
      };
    this.app.dom.elevenKeySaveBtn.onclick = () => void this.applyDirectKey(this.app.dom.elevenKeyEl.value.trim());
    if (this.app.dom.kokoroConsentYes) this.app.dom.kokoroConsentYes.onclick = () => void this.confirmKokoro();
    if (this.app.dom.kokoroConsentNo) this.app.dom.kokoroConsentNo.onclick = () => this.cancelKokoro();

    // Initial provider: last explicit UI choice (localStorage) → env pref → ElevenLabs.
    // A previously-consented Kokoro choice loads directly (model already cached) — no
    // re-consent. First-time visitors default to ElevenLabs with the key box.
    const saved = localStorage.getItem(VoicePicker.PROVIDER_LS);
    const pref = saved ?? this.ttsPref ?? 'elevenlabs';
    await this.selectProvider(pref === 'kokoro' ? 'kokoro' : 'elevenlabs');
  }

  /** Reveal the Kokoro download-consent box; the dropdown already shows 'kokoro'. */
  private askKokoroConsent(): void {
    const box = this.app.dom.kokoroConsent;
    if (!box) {
      void this.selectProvider('kokoro'); // no consent UI present → proceed
      return;
    }
    box.hidden = false;
  }

  /** Consent "yes": hide the box and download + activate Kokoro. */
  private async confirmKokoro(): Promise<void> {
    if (this.app.dom.kokoroConsent) this.app.dom.kokoroConsent.hidden = true;
    await this.selectProvider('kokoro');
  }

  /** Consent "cancel": hide the box and stay on ElevenLabs (reverts the dropdown). */
  private cancelKokoro(): void {
    if (this.app.dom.kokoroConsent) this.app.dom.kokoroConsent.hidden = true;
    void this.selectProvider('elevenlabs');
  }

  /**
   * Runtime provider switch. ElevenLabs (the default) always shows the key box: it uses
   * a saved BYO key if present, else the dev `/eleven` proxy, else prompts for a key.
   * Kokoro downloads the in-browser model (progress bar) and needs no key — it's reached
   * only after the consent box (see confirmKokoro), never auto-selected.
   */
  async selectProvider(kind: 'kokoro' | 'elevenlabs'): Promise<void> {
    if (kind === 'kokoro') {
      localStorage.setItem(VoicePicker.PROVIDER_LS, 'kokoro');
      const k = this.makeKokoro();
      this._activeTts = k;
      this.app.dom.elevenKeyRow.hidden = true;
      this.app.log('voice: Kokoro (free, in-browser TTS — MP4 export enabled)');
      this.syncProviderSel();
      // Eagerly download the model so the bar fills before the first Generate.
      this.startKokoroProgress();
      void k.warmup().catch((e) => {
        this.app.log(`voice: Kokoro model failed to load — ${String(e)}`);
        this.stopKokoroProgress();
      });
      await this.populateVoices();
      return;
    }
    this.stopKokoroProgress();
    if (this.app.dom.kokoroConsent) this.app.dom.kokoroConsent.hidden = true;
    localStorage.setItem(VoicePicker.PROVIDER_LS, 'elevenlabs');
    // Always show the key box so a key can be set/overridden (default-ElevenLabs UX).
    this.app.dom.elevenKeyRow.hidden = false;

    // Prefer a saved BYO key → dev proxy → prompt for a key.
    const stored = localStorage.getItem(VoicePicker.KEY_LS) ?? '';
    if (stored && (await ElevenLabsTts.available(ElevenLabsTts.DIRECT_BASE, stored))) {
      this.useDirectKey(stored);
      await this.populateVoices();
      return;
    }
    if (await ElevenLabsTts.available()) {
      this._activeTts = new ElevenLabsTts('/eleven', this.app.audio, () => this.app.recordDest);
      this.app.log('voice: ElevenLabs (dev proxy) — cloned TTS. Paste a key to use your own account.');
    } else {
      this._activeTts = new ElevenLabsTts(ElevenLabsTts.DIRECT_BASE, this.app.audio, () => this.app.recordDest);
      this.app.log('voice: ElevenLabs selected — paste your API key below to enable it, or pick Kokoro for free in-browser TTS.');
    }
    this.syncProviderSel();
    await this.populateVoices();
  }

  /** Reflect the active provider in the dropdown (so it never lies about what's running). */
  private syncProviderSel(): void {
    const sel = this.app.dom.ttsProviderSel;
    if (!sel || sel.hidden) return;
    sel.value = this._activeTts instanceof ElevenLabsTts ? 'elevenlabs' : 'kokoro';
  }

  /** Show the Kokoro model-download progress bar and track it to completion. If the
   *  model is already cached/ready, this stays silent (no flash). */
  private startKokoroProgress(): void {
    const { kokoroProgRow: row, kokoroProg: bar, kokoroProgLabel: label } = this.app.dom;
    if (!row || !bar) return;
    this.kokoroProgUnsub?.();
    this.kokoroProgUnsub = subscribeKokoroProgress((pct, done) => {
      if (done) {
        const wasVisible = !row.hidden;
        bar.value = 100;
        if (label) label.textContent = 'model ready ✓';
        // Only linger if we were actually showing a download; otherwise stay hidden.
        if (wasVisible) window.setTimeout(() => (row.hidden = true), 1200);
        this.kokoroProgUnsub?.();
        this.kokoroProgUnsub = null;
        return;
      }
      row.hidden = false;
      bar.value = pct;
      if (label) label.textContent = `downloading Kokoro model… ${pct}%`;
    });
  }

  private stopKokoroProgress(): void {
    this.kokoroProgUnsub?.();
    this.kokoroProgUnsub = null;
    if (this.app.dom.kokoroProgRow) this.app.dom.kokoroProgRow.hidden = true;
  }

  private static readonly KEY_LS = 'las.elevenLabsKey';
  private static readonly PROVIDER_LS = 'las.ttsProvider';

  private useDirectKey(key: string): void {
    this._activeTts = new ElevenLabsTts(ElevenLabsTts.DIRECT_BASE, this.app.audio, () => this.app.recordDest, key);
    localStorage.setItem(VoicePicker.PROVIDER_LS, 'elevenlabs');
    this.app.dom.elevenKeyEl.value = '';
    this.app.dom.elevenKeyEl.placeholder = 'ElevenLabs key active ✓ (blank + Use key to forget)';
    this.app.log('voice: ElevenLabs via your key — calls go straight from this browser to the API');
    this.syncProviderSel();
  }

  /** "Use key" click: validate + persist, or (blank) forget the key (staying on ElevenLabs:
   *  the dev proxy if present, else a prompt). Switching to free Kokoro is via the dropdown. */
  private async applyDirectKey(key: string): Promise<void> {
    if (!key) {
      localStorage.removeItem(VoicePicker.KEY_LS);
      this.app.dom.elevenKeyEl.placeholder = 'ElevenLabs API key…';
      this.app.log('voice: ElevenLabs key forgotten.');
      await this.selectProvider('elevenlabs');
      return;
    }
    if (!(await ElevenLabsTts.available(ElevenLabsTts.DIRECT_BASE, key))) {
      this.app.log('voice: that ElevenLabs key was rejected by the API — not saved');
      return;
    }
    localStorage.setItem(VoicePicker.KEY_LS, key);
    this.useDirectKey(key);
    await this.populateVoices();
  }
}
