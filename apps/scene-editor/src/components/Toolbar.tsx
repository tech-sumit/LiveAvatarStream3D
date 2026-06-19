import type { Job } from '@las/protocol';
import type { TransformMode } from './StatusBar.js';

interface Props {
  busy: boolean;
  viewMode: 'editor' | 'activeCamera';
  onViewMode: (m: 'editor' | 'activeCamera') => void;
  transformMode: TransformMode;
  onTransformMode: (m: TransformMode) => void;
  showGrid: boolean;
  showAxes: boolean;
  snapEnabled: boolean;
  onToggleGrid: () => void;
  onToggleAxes: () => void;
  onToggleSnap: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onFocusSelected: () => void;
  onSave: () => void;
  onRecord: () => void;
  job: Job | null;
  downloadUrl?: string;
}

export function Toolbar({
  busy,
  viewMode,
  onViewMode,
  transformMode,
  onTransformMode,
  showGrid,
  showAxes,
  snapEnabled,
  onToggleGrid,
  onToggleAxes,
  onToggleSnap,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onFocusSelected,
  onSave,
  onRecord,
  job,
  downloadUrl,
}: Props) {
  const jobRunning = job && job.status !== 'succeeded' && job.status !== 'failed';

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <span className="toolbar-label">Edit</span>
        <button type="button" className="btn sm secondary" disabled={!canUndo} onClick={onUndo} title="Undo (⌘Z)">
          ↩ Undo
        </button>
        <button type="button" className="btn sm secondary" disabled={!canRedo} onClick={onRedo} title="Redo (⌘⇧Z)">
          ↪ Redo
        </button>
        <button type="button" className="btn sm secondary" onClick={onSave} title="Save (⌘S)">
          Save
        </button>
      </div>

      <div className="toolbar-group">
        <span className="toolbar-label">Transform</span>
        <button
          type="button"
          className={`btn sm icon ${transformMode === 'translate' ? 'active' : ''}`}
          onClick={() => onTransformMode('translate')}
          title="Move (G)"
        >
          G
        </button>
        <button
          type="button"
          className={`btn sm icon ${transformMode === 'rotate' ? 'active' : ''}`}
          onClick={() => onTransformMode('rotate')}
          title="Rotate (R)"
        >
          R
        </button>
        <button
          type="button"
          className={`btn sm icon ${transformMode === 'scale' ? 'active' : ''}`}
          onClick={() => onTransformMode('scale')}
          title="Scale (S)"
        >
          S
        </button>
        <button type="button" className="btn sm secondary" onClick={onFocusSelected} title="Frame selected (F)">
          Focus
        </button>
      </div>

      <div className="toolbar-group">
        <span className="toolbar-label">View</span>
        <button
          type="button"
          className={`btn sm secondary ${viewMode === 'editor' ? 'active' : ''}`}
          onClick={() => onViewMode('editor')}
        >
          Editor
        </button>
        <button
          type="button"
          className={`btn sm secondary ${viewMode === 'activeCamera' ? 'active' : ''}`}
          onClick={() => onViewMode('activeCamera')}
        >
          Active cam
        </button>
        <button
          type="button"
          className={`btn sm secondary ${showGrid ? 'active' : ''}`}
          onClick={onToggleGrid}
          title="Toggle grid"
        >
          Grid
        </button>
        <button
          type="button"
          className={`btn sm secondary ${showAxes ? 'active' : ''}`}
          onClick={onToggleAxes}
          title="Toggle axes"
        >
          Axes
        </button>
        <button
          type="button"
          className={`btn sm secondary ${snapEnabled ? 'active' : ''}`}
          onClick={onToggleSnap}
          title="Snap to 0.25m grid"
        >
          Snap
        </button>
      </div>

      <div className="toolbar-group">
        <span className="toolbar-label">Output</span>
        <button type="button" className="btn sm primary" disabled={busy} onClick={onRecord}>
          {busy ? 'Recording…' : 'Record'}
        </button>
        {downloadUrl && (
          <a className="btn sm secondary" href={downloadUrl}>
            Download
          </a>
        )}
        {jobRunning && <span className="status-pill running">{job.status}</span>}
      </div>
    </div>
  );
}
