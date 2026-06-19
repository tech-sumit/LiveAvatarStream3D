import type { SceneNode, Transform } from '@las/protocol';
import { useState, type ReactNode } from 'react';
import { AVATAR_CATALOG, AVATAR_DOWNLOADS, getAvatarEntry } from '../lib/avatars.js';

interface Props {
  node: SceneNode | null;
  lipSyncDemo: boolean;
  onLipSyncDemo: (on: boolean) => void;
  onChange: (patch: Partial<SceneNode>) => void;
}

function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="inspector-section">
      <button type="button" className="inspector-section-head" onClick={() => setOpen((o) => !o)}>
        <span>{open ? '▾' : '▸'}</span> {title}
      </button>
      {open && <div className="inspector-section-body">{children}</div>}
    </div>
  );
}

function Vec3Input({
  label,
  value,
  step = 0.01,
  onChange,
}: {
  label: string;
  value: Transform['position'];
  step?: number;
  onChange: (v: Transform['position']) => void;
}) {
  return (
    <div className="vec3-field">
      <label className="vec3-label">{label}</label>
      <div className="vec3-inputs">
        {(['X', 'Y', 'Z'] as const).map((axis, i) => (
          <label key={axis} className="vec3-axis">
            <span>{axis}</span>
            <input
              type="number"
              step={step}
              value={value[i]}
              onChange={(e) => {
                const next = [...value] as Transform['position'];
                next[i] = Number(e.target.value);
                onChange(next);
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

export function Inspector({ node, lipSyncDemo, onLipSyncDemo, onChange }: Props) {
  if (!node) {
    return (
      <div className="card inspector-card">
        <h2>Inspector</h2>
        <p className="muted empty-hint">Select a node in the scene graph or click an object in the viewport.</p>
      </div>
    );
  }

  const t = node.transform;

  return (
    <div className="card inspector-card">
      <h2>Inspector</h2>

      <Section title="Object">
        <label>Name</label>
        <input value={node.name} onChange={(e) => onChange({ name: e.target.value })} />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={node.visible}
            onChange={(e) => onChange({ visible: e.target.checked })}
          />
          Visible in viewport & render
        </label>
      </Section>

      <Section title="Transform">
        <Vec3Input
          label="Position"
          step={0.05}
          value={t.position}
          onChange={(position) => onChange({ transform: { ...t, position } })}
        />
        <Vec3Input
          label="Rotation °"
          step={1}
          value={t.rotation}
          onChange={(rotation) => onChange({ transform: { ...t, rotation } })}
        />
        <Vec3Input
          label="Scale"
          step={0.05}
          value={t.scale}
          onChange={(scale) => onChange({ transform: { ...t, scale } })}
        />
        <label className="vec3-label">Size (uniform)</label>
        <input
          type="number"
          step={0.05}
          min={0.01}
          value={Math.max(t.scale[0], t.scale[1], t.scale[2])}
          onChange={(e) => {
            const s = Math.max(0.01, Number(e.target.value) || 1);
            onChange({ transform: { ...t, scale: [s, s, s] } });
          }}
        />
      </Section>

      {node.type === 'camera' && (
        <Section title="Camera">
          <label>FOV</label>
          <input
            type="number"
            min={10}
            max={120}
            value={node.fov}
            onChange={(e) => onChange({ fov: Number(e.target.value) })}
          />
          <label>Target preset</label>
          <select
            value={node.target}
            onChange={(e) => onChange({ target: e.target.value as typeof node.target })}
          >
            {(['eyes', 'face', 'chest', 'torso', 'full_body'] as const).map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </Section>
      )}

      {node.type === 'light' && (
        <Section title="Light">
          <label>Type</label>
          <select
            value={node.lightType}
            onChange={(e) => onChange({ lightType: e.target.value as typeof node.lightType })}
          >
            {(['ambient', 'directional', 'hemisphere', 'point'] as const).map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <label>Color</label>
          <input type="color" value={node.color} onChange={(e) => onChange({ color: e.target.value })} />
          <label>Intensity</label>
          <input
            type="range"
            min={0}
            max={3}
            step={0.1}
            value={node.intensity}
            onChange={(e) => onChange({ intensity: Number(e.target.value) })}
          />
        </Section>
      )}

      {node.type === 'avatar' && (
        <Section title="Avatar">
          <label>Character</label>
          <select value={node.avatarId} onChange={(e) => onChange({ avatarId: e.target.value })}>
            {AVATAR_CATALOG.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          <p className="inspector-hint">{getAvatarEntry(node.avatarId).notes}</p>
          <p className="inspector-hint">
            Lip-sync: <strong>{getAvatarEntry(node.avatarId).lipSync.replace(/_/g, ' ')}</strong>
            {getAvatarEntry(node.avatarId).renderOnPod ? ' · H100 render ready' : ' · preview only'}
          </p>
          {getAvatarEntry(node.avatarId).lipSync === 'decal_viseme' && (
            <>
              <p className="inspector-hint">
                Uses <a href="https://threejs.org/examples/#webgl_decals" target="_blank" rel="noreferrer">DecalGeometry</a>{' '}
                — mouth visemes projected onto the bust (editor POC).
              </p>
              <button
                type="button"
                className={`btn sm ${lipSyncDemo ? 'primary' : 'secondary'}`}
                onClick={() => onLipSyncDemo(!lipSyncDemo)}
              >
                {lipSyncDemo ? 'Stop decal lip-sync demo' : 'Test decal lip-sync'}
              </button>
            </>
          )}
          {node.avatarId === 'ada' && (
            <p className="inspector-hint warn">
              Copy ada.glb from the H100 pod into public/avatars/ for the real preview (Michelle
              stands in until then).
            </p>
          )}
          <details className="avatar-sources">
            <summary>More free humanoid sources</summary>
            <ul>
              {AVATAR_DOWNLOADS.map((d) => (
                <li key={d.name}>
                  <a href={d.url} target="_blank" rel="noreferrer">
                    {d.name}
                  </a>
                  — {d.license}
                </li>
              ))}
            </ul>
          </details>
        </Section>
      )}

      {node.type === 'prop' && (
        <Section title="Prop" defaultOpen={false}>
          <label>Asset key</label>
          <input value={node.assetKey} onChange={(e) => onChange({ assetKey: e.target.value })} />
        </Section>
      )}
    </div>
  );
}
