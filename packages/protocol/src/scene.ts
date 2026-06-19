import { z } from 'zod';
import type { StageSpec } from './manifest.js';
import type { Script } from './dsl.js';
import type { EngineRenderSpec } from './jobs.js';

/** Euler rotation in degrees (XYZ). */
export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;

export const Transform = z.object({
  position: Vec3.default([0, 0, 0]),
  /** Euler rotation in degrees. */
  rotation: Vec3.default([0, 0, 0]),
  scale: Vec3.default([1, 1, 1]),
});
export type Transform = z.infer<typeof Transform>;

const SceneNodeBase = z.object({
  id: z.string(),
  name: z.string(),
  transform: Transform.default({}),
  visible: z.boolean().default(true),
});

export const AvatarSceneNode = SceneNodeBase.extend({
  type: z.literal('avatar'),
  avatarId: z.string().default('ada'),
});

export const PropSceneNode = SceneNodeBase.extend({
  type: z.literal('prop'),
  /** R2 object key or local asset id for a glTF/GLB prop. */
  assetKey: z.string(),
});

export const LightSceneNode = SceneNodeBase.extend({
  type: z.literal('light'),
  lightType: z.enum(['ambient', 'directional', 'hemisphere', 'point']).default('directional'),
  color: z.string().default('#ffffff'),
  intensity: z.number().min(0).default(1),
});

export const CameraSceneNode = SceneNodeBase.extend({
  type: z.literal('camera'),
  fov: z.number().min(10).max(120).default(50),
  target: z.enum(['eyes', 'face', 'chest', 'torso', 'full_body']).default('face'),
  near: z.number().positive().default(0.1),
  far: z.number().positive().default(100),
});

export const SceneNode = z.discriminatedUnion('type', [
  AvatarSceneNode,
  PropSceneNode,
  LightSceneNode,
  CameraSceneNode,
]);
export type SceneNode = z.infer<typeof SceneNode>;

/** Authoring-time scene graph synced between the web editor and engine-three. */
export const SceneDocument = z.object({
  version: z.literal(1).default(1),
  id: z.string(),
  name: z.string(),
  stage: z
    .object({
      level: z.string().default('studio'),
      lighting: z.string().default('three_point_warm'),
      background: z.string().default('#1a2030'),
    })
    .default({}),
  nodes: z.array(SceneNode).min(1),
  /** Which camera node drives the render viewport. */
  activeCameraId: z.string(),
});
export type SceneDocument = z.infer<typeof SceneDocument>;

export function createDefaultScene(id = 'scene_default'): SceneDocument {
  const camId = 'cam_main';
  const avatarId = 'avatar_main';
  return SceneDocument.parse({
    version: 1,
    id,
    name: 'Untitled scene',
    stage: { level: 'studio', lighting: 'three_point_warm', background: '#1a2030' },
    activeCameraId: camId,
    nodes: [
      {
        id: camId,
        name: 'Main Camera',
        type: 'camera',
        fov: 50,
        target: 'face',
        transform: { position: [0, 1.6, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      {
        id: avatarId,
        name: 'Avatar',
        type: 'avatar',
        avatarId: 'ada',
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      {
        id: 'light_key',
        name: 'Key Light',
        type: 'light',
        lightType: 'directional',
        color: '#ffe8d0',
        intensity: 1.4,
        transform: { position: [2.5, 4, 3], rotation: [-45, 30, 0], scale: [1, 1, 1] },
      },
      {
        id: 'floor',
        name: 'Floor',
        type: 'prop',
        assetKey: '__builtin_floor__',
        transform: { position: [0, 0, 0], rotation: [-90, 0, 0], scale: [6, 6, 1] },
      },
    ],
  });
}

/** Map editor scene → engine StageSpec (avatar + lighting presets). */
export function sceneToStageSpec(doc: SceneDocument): StageSpec {
  const avatar = doc.nodes.find((n): n is z.infer<typeof AvatarSceneNode> => n.type === 'avatar');
  return {
    level: doc.stage.level,
    lighting: doc.stage.lighting,
    avatarId: avatar?.avatarId ?? 'ada',
  };
}

/** Build an engine_render job spec from a saved scene + script. */
export function sceneToEngineRenderSpec(
  doc: SceneDocument,
  voiceId: string,
  script: Script,
  fps = 24,
): EngineRenderSpec {
  return {
    avatarId: sceneToStageSpec(doc).avatarId,
    voiceId,
    script,
    stage: { level: doc.stage.level, lighting: doc.stage.lighting },
    fps,
    resolution: { width: 1920, height: 1080 },
    scene: doc,
  };
}
