import type { SceneNode } from '@las/protocol';

export type TransformMode = 'translate' | 'rotate' | 'scale';

interface Props {
  sceneName: string;
  nodeCount: number;
  selected: SceneNode | null;
  transformMode: TransformMode;
  snapEnabled: boolean;
  viewMode: 'editor' | 'activeCamera';
}

const MODE_LABEL: Record<TransformMode, string> = {
  translate: 'Move',
  rotate: 'Rotate',
  scale: 'Scale',
};

export function StatusBar({ sceneName, nodeCount, selected, transformMode, snapEnabled, viewMode }: Props) {
  return (
    <footer className="status-bar">
      <span className="status-item">{sceneName}</span>
      <span className="status-sep">·</span>
      <span className="status-item">{nodeCount} nodes</span>
      {selected && (
        <>
          <span className="status-sep">·</span>
          <span className="status-item">
            {selected.type}: <strong>{selected.name}</strong>
          </span>
        </>
      )}
      <span className="status-spacer" />
      <span className="status-item muted">{viewMode === 'activeCamera' ? 'Active cam' : 'Editor cam'}</span>
      <span className="status-sep">·</span>
      <span className="status-item">{MODE_LABEL[transformMode]}</span>
      {snapEnabled && (
        <>
          <span className="status-sep">·</span>
          <span className="status-item snap-on">Snap</span>
        </>
      )}
      <span className="status-sep">·</span>
      <span className="status-item muted">G R S · F focus · Del · ⌘Z ⌘⇧Z</span>
    </footer>
  );
}
