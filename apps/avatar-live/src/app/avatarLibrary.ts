import { type Shot } from '../scene/stage.js';
import type { StudioContext } from './context.js';

// Folders are auto-indexed by the Vite avatar plugin (→ /avatars.json). Each avatar
// carries its own lip-sync config so "how much the lips move" is per-model.
interface AvatarConfig {
  id: string;
  label: string;
  description?: string;
  model: string; // filename inside the folder
  shot?: Shot;
  bodyAnim?: boolean; // force body animation on/off (undefined → humanoid auto-detect)
  lipsync: { gain: number; jaw: number; wide: number; round: number; smoothing: number };
}
export const DEFAULT_LIP = { gain: 1, jaw: 1, wide: 1, round: 1, smoothing: 0.2 };
// Pre-folder-migration projects stored raw model paths; map them to the new ids.
const LEGACY_AVATAR_IDS: Record<string, string> = {
  '/avatars/avaturn.glb': 'avaturn-model',
  '/avatars/brunette.glb': 'brunette-model',
  '/avatars/human.glb': 'facecap-model',
  '/avatars/avatarsdk.glb': 'avatarsdk-model',
};

/** Avatar discovery, loading (folder / file / URL) + per-avatar lip-sync calibration. */
export class AvatarLibrary {
  private avatarConfigs = new Map<string, AvatarConfig>();
  private currentAvatarId: string | null = null; // null = a file/URL-loaded avatar (not a folder)
  private adHocUrl: string | null = null; // a persistable http(s) URL for an ad-hoc avatar (not a blob:)
  private lipCfg = { ...DEFAULT_LIP }; // active lip-sync config (drives setLipsync + analyser smoothing)
  constructor(private app: StudioContext) {}

  get currentId(): string | null {
    return this.currentAvatarId;
  }
  /** Live lip-sync config (read by the Performer for analyser smoothing). */
  get lip() {
    return this.lipCfg;
  }

  // bodyAnim true/false forces body animation on/off; undefined → humanoid auto-detect.
  private loadAvatar = async (url: string, label: string, bodyAnim?: boolean): Promise<boolean> => {
    const { avatar, stage, dom, log } = this.app;
    log(`loading ${label}…`);
    try {
      const res = await avatar.loadGltf(url);
      if (res.mode === 'none') {
        log(`⚠ ${label}: ${res.detail}. Use an ARKit/Oculus-blendshape avatar (e.g. Ready Player Me).`);
        return false;
      }
      avatar.setPosition(0, 0, 0);
      avatar.group.quaternion.identity();
      stage.frame(avatar.headCenter, avatar.headHeight, dom.shotSel.value as Shot);
      dom.statusEl.textContent = avatar.description;
      log(`loaded ${label} — ${res.detail}`);
      if (res.mode === 'jawbone') log('note: jaw-bone lipsync is open/close only (no visemes/expression).');
      await this.setupBodyAnimation(bodyAnim ?? avatar.isReadyPlayerMe);
      return true;
    } catch (err) {
      log(`failed to load ${label}: ${String(err)}`);
      return false;
    }
  };

  private setupBodyAnimation = async (enabled: boolean): Promise<void> => {
    const { avatar, log } = this.app;
    if (!enabled) {
      log('body animation: off for this avatar.');
      return;
    }
    const got = await avatar.loadAnimations([
      { name: 'idle', url: '/animations/idle.glb' },
      { name: 'idle_calm', url: '/animations/idle_calm.glb' },
      { name: 'talk1', url: '/animations/talk1.glb' },
      { name: 'talk2', url: '/animations/talk2.glb' },
      { name: 'talk3', url: '/animations/talk3.glb' },
      { name: 'talk4', url: '/animations/talk4.glb' },
      { name: 'talk5', url: '/animations/talk5.glb' },
    ]);
    if (got.includes('idle')) avatar.playClip('idle', 0);
    log(
      got.length
        ? `body animation: ${got.length} clips (${got.join(', ')})`
        : 'body animation: no clips found — run scripts/fetch-animations.sh',
    );
  };

  private discoverAvatars = async (): Promise<void> => {
    const { dom, log } = this.app;
    let ids: string[] = [];
    try {
      ids = (await (await fetch('/avatars.json')).json()) as string[];
    } catch {
      ids = [];
    }
    dom.avatarSel.innerHTML = '';
    for (const id of ids) {
      try {
        const c = (await (await fetch(`/${id}/config.json`)).json()) as Partial<AvatarConfig>;
        const cfg: AvatarConfig = {
          id,
          label: c.label || id,
          description: c.description,
          model: c.model || 'model.glb',
          shot: c.shot,
          bodyAnim: c.bodyAnim,
          lipsync: { ...DEFAULT_LIP, ...(c.lipsync || {}) },
        };
        this.avatarConfigs.set(id, cfg);
        const o = document.createElement('option');
        o.value = id;
        o.textContent = cfg.label;
        dom.avatarSel.appendChild(o);
      } catch {
        /* skip a malformed avatar folder */
      }
    }
    log(`avatars: discovered ${this.avatarConfigs.size} (${[...this.avatarConfigs.keys()].join(', ') || 'none'})`);
  };

  private applyLipCfg(c: Partial<typeof DEFAULT_LIP>): void {
    const { avatar, dom } = this.app;
    this.lipCfg = { ...DEFAULT_LIP, ...c };
    avatar.setLipsync(this.lipCfg);
    dom.lipGainEl.value = String(this.lipCfg.gain);
    dom.lipJawEl.value = String(this.lipCfg.jaw);
    dom.lipWideEl.value = String(this.lipCfg.wide);
    dom.lipRoundEl.value = String(this.lipCfg.round);
    dom.lipSmoothEl.value = String(this.lipCfg.smoothing);
  }

  loadById = async (id: string): Promise<boolean> => {
    const { dom } = this.app;
    const cfg = this.avatarConfigs.get(id);
    if (!cfg) return false;
    const prevShot = dom.shotSel.value;
    if (cfg.shot) dom.shotSel.value = cfg.shot; // so loadAvatar frames with the right shot
    const ok = await this.loadAvatar(`/${id}/${cfg.model}`, cfg.label, cfg.bodyAnim);
    if (ok) {
      this.currentAvatarId = id;
      this.adHocUrl = null;
      this.applyLipCfg(cfg.lipsync); // only adopt this avatar's lip config once it actually loaded
      dom.lipSaveBtn.disabled = false;
      dom.lipDimEl.textContent = `calibrating ${cfg.label} — saves to ${id}/config.json`;
    } else {
      dom.shotSel.value = prevShot; // failed → keep the still-displayed avatar's state intact
    }
    return ok;
  };

  // A file/URL-loaded avatar isn't a discovered folder, so it can't save config.
  // http(s) URLs are remembered so the project can persist them; blob: cannot.
  loadAdHoc = (url: string, label: string): Promise<boolean> => {
    this.currentAvatarId = null;
    this.adHocUrl = /^https?:\/\//.test(url) ? url : null;
    this.app.dom.lipSaveBtn.disabled = true;
    this.applyLipCfg(DEFAULT_LIP);
    return this.loadAvatar(url, label);
  };

  private readLipSliders(): typeof DEFAULT_LIP {
    const d = this.app.dom;
    return {
      gain: Number(d.lipGainEl.value),
      jaw: Number(d.lipJawEl.value),
      wide: Number(d.lipWideEl.value),
      round: Number(d.lipRoundEl.value),
      smoothing: Number(d.lipSmoothEl.value),
    };
  }

  serialize(): { avatarUrl: string } {
    return { avatarUrl: this.currentAvatarId ?? this.adHocUrl ?? '' };
  }
  async apply(doc: { avatarUrl?: string }): Promise<void> {
    const { dom, log } = this.app;
    if (!doc.avatarUrl) return;
    const ref = LEGACY_AVATAR_IDS[doc.avatarUrl] ?? doc.avatarUrl;
    if (this.avatarConfigs.has(ref)) {
      if (ref !== this.currentAvatarId) {
        dom.avatarSel.value = ref;
        await this.loadById(ref);
      }
    } else if (/^https?:\/\//.test(ref)) {
      await this.loadAdHoc(ref, ref.split('/').pop() || 'avatar');
    } else {
      log(`project avatar "${doc.avatarUrl}" not found — keeping the current avatar.`);
    }
  }

  async init(): Promise<void> {
    const { dom, log, avatar, stage } = this.app;
    dom.glbInput.addEventListener('change', async () => {
      const file = dom.glbInput.files?.[0];
      if (!file) return;
      if (this.app.isBusy()) {
        log('finish the current take before changing the avatar.');
        return;
      }
      const url = URL.createObjectURL(file);
      try {
        await this.loadAdHoc(url, file.name);
      } finally {
        URL.revokeObjectURL(url);
      }
    });
    dom.avatarSel.addEventListener('change', () => {
      if (this.app.isBusy()) {
        log('finish the current take before switching avatars.');
        dom.avatarSel.value = this.currentAvatarId ?? dom.avatarSel.value; // undo the dropdown change
        return;
      }
      void this.loadById(dom.avatarSel.value);
    });
    dom.loadUrlBtn.addEventListener('click', () => {
      if (this.app.isBusy()) {
        log('finish the current take before changing the avatar.');
        return;
      }
      const url = dom.glbUrlInput.value.trim();
      if (url) void this.loadAdHoc(url, url.split('/').pop() || 'url');
    });
    dom.glbUrlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') dom.loadUrlBtn.click();
    });
    [dom.lipGainEl, dom.lipJawEl, dom.lipWideEl, dom.lipRoundEl, dom.lipSmoothEl].forEach((el) =>
      el.addEventListener('input', () => {
        this.lipCfg = this.readLipSliders();
        avatar.setLipsync(this.lipCfg); // gain/jaw/wide/round apply live; smoothing on next utterance
      }),
    );
    dom.lipSaveBtn.addEventListener('click', async () => {
      if (!this.currentAvatarId) {
        log('select a discovered avatar (not a file/URL load) to save its lip-sync config.');
        return;
      }
      const cfg = this.avatarConfigs.get(this.currentAvatarId);
      if (!cfg) return;
      cfg.lipsync = this.readLipSliders();
      cfg.shot = dom.shotSel.value as Shot; // persist the live shot too, not the stale cached one
      const docOut = { label: cfg.label, description: cfg.description, model: cfg.model, shot: cfg.shot, lipsync: cfg.lipsync };
      try {
        const r = await fetch(`/avatar-config/${this.currentAvatarId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(docOut),
        });
        log(r.ok ? `saved lip-sync config → ${this.currentAvatarId}/config.json` : `save failed (${r.status})`);
      } catch (err) {
        log(`save failed: ${String(err)}`);
      }
    });

    // Initial framing + discovery + auto-load (prefer the photoreal Avaturn anchor).
    stage.frame(avatar.headCenter, avatar.headHeight, dom.shotSel.value as Shot);
    dom.statusEl.textContent = avatar.description;
    await this.discoverAvatars();
    const ids = [...this.avatarConfigs.keys()];
    const order = ['avaturn-model', ...ids.filter((i) => i !== 'avaturn-model')];
    for (const id of order) {
      if (this.avatarConfigs.has(id) && (await this.loadById(id))) {
        dom.avatarSel.value = id;
        return;
      }
    }
    log('using procedural head — drop a blendshape GLB in public/<name>-model/model.glb.');
  }
}
