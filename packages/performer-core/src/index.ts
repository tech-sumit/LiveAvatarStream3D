// Public barrel. Types are re-exported with `export type` (verbatimModuleSyntax + isolatedModules
// forbid value-re-exporting a type); the eight solver value-fns are exported separately.
export type {
  Vec3,
  Quat,
  Subject,
  ShotSize,
  Composition,
  CameraMove,
  Pose,
  PathSample,
  PathPlan,
  Side,
  LimbAim,
  EyeAim,
  FingerCurls,
  GestureKind,
  GestureParams,
  DriveKind,
  BaseEnergy,
  Drive,
} from './types.js';

export type { ShotSubject, ShotMove, ShotPreset, CameraShotId } from './cameraShots.js';
export { CAMERA_SHOTS, CAMERA_SHOT_IDS, sampleShot } from './cameraShots.js';

export { composeShot } from './composeShot.js';
export { moveCamera } from './moveCamera.js';
export { planPath } from './planPath.js';
export { turnToward } from './turnToward.js';
export { aimLimb } from './aimLimb.js';
export { aimEye } from './aimEye.js';
export { resolveGesture } from './resolveGesture.js';
export { fingerCount } from './fingerCount.js';
