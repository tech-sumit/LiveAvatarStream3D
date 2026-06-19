import type { SceneDocument, SceneNode } from '@las/protocol';
import { useRef } from 'react';
import { api } from '../lib/api.js';

interface Props {
  scene: SceneDocument;
  selectedId: string;
  onSelect: (id: string) => void;
  onRenameScene: (name: string) => void;
  onAdd: (node: SceneNode) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onSetActiveCamera: (id: string) => void;
  onImportGlb: (file: File, assetKey: string, previewUrl: string) => void;
  importBusy: boolean;
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

export function SceneGraph({
  scene,
  selectedId,
  onSelect,
  onRenameScene,
  onAdd,
  onRemove,
  onDuplicate,
  onToggleVisible,
  onSetActiveCamera,
  onImportGlb,
  importBusy,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleImport(file: File) {
    const previewUrl = URL.createObjectURL(file);
    let assetKey = `local/${file.name}`;
    try {
      const { key } = await api.uploadGlb(file);
      assetKey = key;
    } catch {
      // Preview locally when API is offline.
    }
    onImportGlb(file, assetKey, previewUrl);
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <div className="card scene-graph-card">
      <div className="panel-head">
        <div className="scene-title-row">
          <input
            className="scene-name-input"
            value={scene.name}
            onChange={(e) => onRenameScene(e.target.value)}
            aria-label="Scene name"
          />
          <span className="node-count">{scene.nodes.length}</span>
        </div>
        <div className="row add-row">
          <button
            type="button"
            className="btn sm btn-import"
            disabled={importBusy}
            onClick={() => fileRef.current?.click()}
            title="Import GLB prop"
          >
            GLB
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".glb,.gltf,model/gltf-binary"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImport(f);
            }}
          />
          <button
            type="button"
            className="btn sm"
            title="Add box prop"
            onClick={() =>
              onAdd({
                id: newId('prop'),
                name: 'Box',
                type: 'prop',
                assetKey: `local/box_${Date.now()}`,
                transform: { position: [0, 0.25, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
                visible: true,
              })
            }
          >
            + Box
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              onAdd({
                id: newId('light'),
                name: 'Light',
                type: 'light',
                lightType: 'directional',
                color: '#ffffff',
                intensity: 1,
                transform: { position: [2, 3, 2], rotation: [-45, 30, 0], scale: [1, 1, 1] },
                visible: true,
              })
            }
          >
            + Light
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              onAdd({
                id: newId('cam'),
                name: 'Camera',
                type: 'camera',
                fov: 50,
                target: 'face',
                near: 0.1,
                far: 100,
                transform: { position: [0, 1.6, 2.5], rotation: [0, 0, 0], scale: [1, 1, 1] },
                visible: true,
              })
            }
          >
            + Cam
          </button>
        </div>
      </div>
      <ul className="tree">
        {scene.nodes.map((n) => (
          <li
            key={n.id}
            className={`tree-item ${selectedId === n.id ? 'selected' : ''} ${!n.visible ? 'hidden-node' : ''}`}
          >
            <button
              type="button"
              className={`tree-eye ${n.visible ? 'on' : ''}`}
              title={n.visible ? 'Hide' : 'Show'}
              onClick={(e) => {
                e.stopPropagation();
                onToggleVisible(n.id);
              }}
            >
              {n.visible ? '◉' : '○'}
            </button>
            <button type="button" className="tree-label" onClick={() => onSelect(n.id)}>
              <span className={`tag ${n.type}`}>{n.type.slice(0, 3)}</span>
              <span className="node-name">{n.name}</span>
              {n.type === 'camera' && scene.activeCameraId === n.id && (
                <span className="tag active-cam">rec</span>
              )}
            </button>
            <div className="tree-actions">
              <button type="button" className="btn xs" title="Duplicate" onClick={() => onDuplicate(n.id)}>
                ⧉
              </button>
              {n.type === 'camera' && scene.activeCameraId !== n.id && (
                <button type="button" className="btn xs" onClick={() => onSetActiveCamera(n.id)}>
                  ★
                </button>
              )}
              <button type="button" className="btn xs danger" onClick={() => onRemove(n.id)}>
                ×
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
