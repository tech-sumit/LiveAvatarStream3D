// SuVi AI News studio — wiring layer. Builds the StudioContext, constructs the
// feature controllers in dependency order, wires the busy guard, and inits each.
// All behaviour lives in the controllers under ./app/.
import { StudioContext } from './app/context.js';
import { Lighting } from './app/lighting.js';
import { Look } from './app/look.js';
import { Recording } from './app/recording.js';
import { BackScreen } from './app/backScreen.js';
import { AvatarTransform } from './app/avatarTransform.js';
import { VoicePicker } from './app/voicePicker.js';
import { AvatarLibrary } from './app/avatarLibrary.js';
import { TimelineEditor } from './app/timelineEditor.js';
import { Performer } from './app/performer.js';
import { ProjectStore } from './app/projectStore.js';

const app = new StudioContext();

// Leaves + library/timeline → performer (the engine) → projectStore (touches all).
const lighting = new Lighting(app);
const look = new Look(app);
const recording = new Recording(app);
const backScreen = new BackScreen(app);
const transform = new AvatarTransform(app);
const voices = new VoicePicker(app);
const library = new AvatarLibrary(app);
const timeline = new TimelineEditor(app);
const performer = new Performer(app, { voices, recording, library, timeline, transform });
timeline.attachPerformer(performer);
const projects = new ProjectStore(app, { library, voices, lighting, look, backScreen, timeline, performer });

// Busy guard: block avatar switches / preview while performing, previewing, or recording.
app.isBusy = () => performer.busy || timeline.busy || recording.active;

lighting.init();
look.init();
recording.init();
backScreen.init();
transform.init();
performer.init();
timeline.init();
void voices.init();
void library.init();
void projects.init();

app.log(`ready · avatar: ${app.avatar.description}`);

// Debug handle for inspecting the scene/camera from the console.
(window as unknown as { __las: unknown }).__las = {
  stage: app.stage,
  avatar: app.avatar,
  studio: app.studio,
  wallVideo: backScreen.video,
};
