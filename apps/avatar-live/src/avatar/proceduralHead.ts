import * as THREE from 'three';
import type { FaceChannels, FaceRig } from './face.js';

// A stylized head built from primitives so the realtime pipeline is demonstrable
// with zero downloaded assets. It implements FaceRig by transforming a mouth mesh
// and eyelids directly (no morph targets needed). Drop a real ARKit/Oculus .glb
// in and MorphFaceRig takes over — the rest of the app is identical.
export interface ProceduralAvatar {
  group: THREE.Group;
  rig: FaceRig;
  /** Approx world-space head center, for camera framing. */
  headCenter: THREE.Vector3;
}

export function createProceduralHead(): ProceduralAvatar {
  const group = new THREE.Group();

  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a37a, roughness: 0.7, metalness: 0.0 });
  const head = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 48), skin);
  head.scale.set(1, 1.18, 0.92);
  head.castShadow = true;
  group.add(head);

  // Neck + shoulders so framing reads like an anchor bust.
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.6, 24), skin);
  neck.position.y = -1.15;
  group.add(neck);
  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.95, 0.5, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0x2b3a55, roughness: 0.8 }),
  );
  torso.position.y = -2.25;
  torso.scale.set(1.35, 1, 0.8);
  group.add(torso);

  const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
  const iris = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.4 });
  const eyeL = makeEye(eyeWhite, iris);
  const eyeR = makeEye(eyeWhite, iris);
  eyeL.position.set(-0.36, 0.18, 0.82);
  eyeR.position.set(0.36, 0.18, 0.82);
  group.add(eyeL, eyeR);

  // Eyelids: thin clipping caps we scale on blink.
  const lidMat = skin.clone();
  const lidL = new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 12), lidMat);
  const lidR = new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 12), lidMat);
  lidL.position.copy(eyeL.position).z += 0.01;
  lidR.position.copy(eyeR.position).z += 0.01;
  lidL.scale.y = 0.02;
  lidR.scale.y = 0.02;
  group.add(lidL, lidR);

  // Brows.
  const browMat = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.8 });
  const browL = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 0.08), browMat);
  const browR = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 0.08), browMat);
  browL.position.set(-0.36, 0.42, 0.86);
  browR.position.set(0.36, 0.42, 0.86);
  group.add(browL, browR);

  // Mouth: a dark rounded cavity we scale for jaw/wide/round/close.
  const mouth = new THREE.Mesh(
    new THREE.SphereGeometry(0.26, 28, 18),
    new THREE.MeshStandardMaterial({ color: 0x5a1f24, roughness: 0.6 }),
  );
  mouth.position.set(0, -0.5, 0.84);
  mouth.scale.set(1, 0.12, 0.4);
  group.add(mouth);

  const baseBrowY = browL.position.y;
  const rig: FaceRig = {
    apply(c: FaceChannels) {
      // Mouth shape: jaw drives height, wide/round trade off width & depth.
      const openY = 0.1 + c.jawOpen * 0.85 - c.mouthClose * 0.08;
      const width = 0.85 + c.mouthWide * 0.55 - c.mouthRound * 0.4;
      const depth = 0.4 + c.mouthRound * 0.5 + c.jawOpen * 0.15;
      mouth.scale.set(width, Math.max(0.05, openY), depth);
      mouth.position.y = -0.5 - c.jawOpen * 0.12;

      // Eyelids close on blink.
      lidL.scale.y = 0.02 + c.blink * 0.95;
      lidR.scale.y = 0.02 + c.blink * 0.95;

      // Brows lift with emphasis / surprise.
      browL.position.y = baseBrowY + c.browRaise * 0.12;
      browR.position.y = baseBrowY + c.browRaise * 0.12;
      browL.rotation.z = -c.frown * 0.25;
      browR.rotation.z = c.frown * 0.25;
    },
  };

  return { group, rig, headCenter: new THREE.Vector3(0, 0.1, 0) };
}

function makeEye(white: THREE.Material, iris: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 24), white);
  const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 16), iris);
  pupil.position.z = 0.12;
  g.add(ball, pupil);
  return g;
}
