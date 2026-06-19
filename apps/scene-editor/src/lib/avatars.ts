/** Bundled + documented free humanoid avatars for the scene editor preview and H100 render. */

export interface AvatarCatalogEntry {
  id: string;
  label: string;
  /** Path under scene-editor public/ or absolute URL. */
  url: string;
  license: string;
  /** Lip-sync path on the GPU render node. */
  lipSync: 'arkit_morphs' | 'viseme_envelope' | 'decal_viseme' | 'none';
  /** Present in engine-three/assets/avatars/registry.json on the H100 pod. */
  renderOnPod: boolean;
  notes: string;
}

export const AVATAR_CATALOG: AvatarCatalogEntry[] = [
  {
    id: 'lee_perry_smith',
    label: 'Lee Perry-Smith — decal lip-sync bust',
    url: '/avatars/LeePerrySmith/LeePerrySmith.glb',
    license: 'Three.js examples (MIT) — Infinite Realities scan',
    lipSync: 'decal_viseme',
    renderOnPod: true,
    notes:
      'Static head bust from webgl_decals. Mouth is a projected decal driven by jaw/viseme at render time.',
  },
  {
    id: 'ada',
    label: 'Ada — realistic human (VALID)',
    url: '/avatars/ada.glb',
    license: 'VALID / c-frame avatars (see valid-avatars-glb)',
    lipSync: 'arkit_morphs',
    renderOnPod: true,
    notes:
      'Production avatar (~28MB, meshopt). Copy ada.glb from the H100 pod into public/avatars/ for editor preview. Best lip-sync match.',
  },
  {
    id: 'michelle',
    label: 'Michelle — skinned humanoid',
    url: '/avatars/michelle.glb',
    license: 'Three.js examples (MIT)',
    lipSync: 'viseme_envelope',
    renderOnPod: false,
    notes: 'Bundled default preview. Mixamo-style rig + idle animation. Viseme/envelope lip-sync on render.',
  },
  {
    id: 'xbot',
    label: 'Xbot — robot humanoid',
    url: '/avatars/xbot.glb',
    license: 'Three.js examples (MIT)',
    lipSync: 'viseme_envelope',
    renderOnPod: false,
    notes: 'Lightweight rigged bot with walk/idle clips. Good for layout tests, not realistic.',
  },
];

/** Additional free sources — import via Scene → GLB or copy into public/avatars/. */
export const AVATAR_DOWNLOADS = [
  {
    name: 'Mixamo characters (Y Bot, X Bot, etc.)',
    url: 'https://www.mixamo.com/',
    license: 'Adobe Mixamo ToS — free with account',
    lipSync: 'Usually none on face; body animations excellent. Export FBX → glTF.',
  },
  {
    name: 'Ready Player Me',
    url: 'https://readyplayer.me/',
    license: 'Free tier for dev',
    lipSync: 'Some exports include blend shapes; good for web avatars.',
  },
  {
    name: 'Quaternius Ultimate Animated Characters',
    url: 'https://quaternius.com/packs/ultimateanimatedcharacterpack.html',
    license: 'CC0',
    lipSync: 'Low-poly, no ARKit morphs — envelope lip-sync only.',
  },
  {
    name: 'VALID avatars (Ada source)',
    url: 'https://github.com/c-frame/valid-avatars-glb',
    license: 'See repo',
    lipSync: 'Realistic humans; same lineage as ada.glb on the pod.',
  },
];

export function getAvatarEntry(avatarId: string): AvatarCatalogEntry {
  return AVATAR_CATALOG.find((a) => a.id === avatarId) ?? AVATAR_CATALOG[1]!;
}

export function resolveAvatarUrl(avatarId: string): string {
  return getAvatarEntry(avatarId).url;
}

/** Fallback preview when ada.glb is not copied locally yet. */
export const AVATAR_PREVIEW_FALLBACK_ID = 'michelle';
