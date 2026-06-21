import { Stage } from '../scene/stage.js';
import { buildNewsStudio } from '../scene/studio.js';
import { AvatarController } from '../avatar/avatarController.js';
import { bindDom, type Dom } from './dom.js';

// Long-lived singletons + cross-cutting helpers, injected into every controller.
// Carries no feature state — only the scene/avatar singletons, DOM refs, the log,
// the shared AudioContext (+ record destination), and the busy guard (assigned by
// main.ts once the controllers exist).
export class StudioContext {
  readonly dom: Dom = bindDom();
  readonly stage = new Stage(this.dom.stageEl);
  readonly studio = buildNewsStudio();
  readonly avatar = new AvatarController();

  // Shared AudioContext + a MediaStream destination so the voice (Web Audio) can be
  // mixed into recordings. Created on the first user gesture (autoplay policy).
  private sharedCtx: AudioContext | null = null;
  recordDest: MediaStreamAudioDestinationNode | null = null;

  /** Set by main.ts after controllers exist (performer.busy || timeline.busy || …). */
  isBusy: () => boolean = () => false;

  constructor() {
    this.stage.add(this.studio.group);
    this.avatar.setRenderer(this.stage.renderer);
    this.stage.add(this.avatar.group);
  }

  log = (msg: string): void => {
    const ts = new Date().toLocaleTimeString();
    this.dom.logEl.textContent = `[${ts}] ${msg}\n${this.dom.logEl.textContent ?? ''}`.slice(0, 4000);
  };

  audio = (): AudioContext => {
    if (!this.sharedCtx) {
      this.sharedCtx = new AudioContext();
      this.recordDest = this.sharedCtx.createMediaStreamDestination();
    }
    return this.sharedCtx;
  };
}
