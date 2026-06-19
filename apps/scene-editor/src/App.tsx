import {
  createDefaultScene,
  sceneToEngineRenderSpec,
  type SceneDocument,
  type SceneNode,
  type ScriptSegment,
  type Job,
  type JobEvent,
  type VoiceProfile,
} from '@las/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Inspector } from './components/Inspector.js';
import { SceneGraph } from './components/SceneGraph.js';
import { ScriptPanel } from './components/ScriptPanel.js';
import { StatusBar, type TransformMode } from './components/StatusBar.js';
import { VoicePanel } from './components/VoicePanel.js';
import { Toolbar } from './components/Toolbar.js';
import { Viewport, type ViewportHandle } from './components/Viewport.js';
import { api } from './lib/api.js';
import { saveScene, loadScene } from './lib/storage.js';
import { emptyScriptLineIndices, newScriptSegment } from './lib/scriptSegment.js';
import { useSceneHistory } from './lib/useSceneHistory.js';

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function newNodeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

export function App() {
  const { scene, setScene, undo, redo, canUndo, canRedo } = useSceneHistory(
    loadScene() ?? createDefaultScene(),
  );
  const [selectedId, setSelectedId] = useState<string>(scene.activeCameraId);
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [voiceId, setVoiceId] = useState('');
  const [segments, setSegments] = useState<ScriptSegment[]>([newScriptSegment(0)]);
  const [scriptNeedsText, setScriptNeedsText] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'editor' | 'activeCamera'>('activeCamera');
  const [transformMode, setTransformMode] = useState<TransformMode>('translate');
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const [snapEnabled, setSnapEnabled] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [importBusy, setImportBusy] = useState(false);
  const [lipSyncDemo, setLipSyncDemo] = useState(false);
  const [cloneBusy, setCloneBusy] = useState(false);
  const viewportRef = useRef<ViewportHandle>(null);

  const selected = useMemo(
    () => scene.nodes.find((n) => n.id === selectedId) ?? null,
    [scene.nodes, selectedId],
  );

  const refreshVoices = useCallback(async () => {
    try {
      const v = await api.listVoices();
      setVoices(v);
      const ready = v.filter((x) => x.status === 'ready');
      setVoiceId((prev) => {
        if (ready.length > 0 && !ready.some((x) => x.id === prev)) return ready[0]!.id;
        return prev;
      });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const upsertVoice = useCallback((voice: VoiceProfile) => {
    setVoices((prev) => {
      const idx = prev.findIndex((v) => v.id === voice.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = voice;
        return next;
      }
      return [voice, ...prev];
    });
  }, []);

  useEffect(() => {
    refreshVoices();
  }, [refreshVoices]);

  useEffect(() => {
    const needsPoll = voices.some((v) => v.status === 'cloning' || v.status === 'pending');
    if (!needsPoll) return;
    const t = setInterval(() => void refreshVoices(), 2000);
    return () => clearInterval(t);
  }, [voices, refreshVoices]);

  useEffect(() => {
    const onFocus = () => void refreshVoices();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshVoices]);

  useEffect(() => {
    if (!job || job.status === 'succeeded' || job.status === 'failed') return;
    const t = setInterval(async () => {
      try {
        const { job: j, events: ev } = await api.getEngineJob(job.id);
        setJob(j);
        setEvents(ev);
      } catch {
        /* transient */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [job]);

  const updateNode = useCallback(
    (id: string, patch: Partial<SceneNode>) => {
      // #region agent log
      if (patch.transform) {
        fetch('http://127.0.0.1:7445/ingest/d520ae88-7e66-4f86-8787-69592b53c18f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'f4aab0'},body:JSON.stringify({sessionId:'f4aab0',location:'App.tsx:updateNode',message:'updateNode transform patch',data:{id,scale:patch.transform.scale},timestamp:Date.now(),hypothesisId:'C'})}).catch(()=>{});
      }
      // #endregion
      setScene((s) => ({
        ...s,
        nodes: s.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as SceneNode) : n)),
      }));
    },
    [setScene],
  );

  const addNode = useCallback(
    (node: SceneNode) => {
      setScene((s) => ({ ...s, nodes: [...s.nodes, node] }));
      setSelectedId(node.id);
    },
    [setScene],
  );

  const removeNode = useCallback(
    (id: string) => {
      setScene((s) => {
        if (s.nodes.length <= 1) return s;
        const nodes = s.nodes.filter((n) => n.id !== id);
        const activeCameraId =
          s.activeCameraId === id
            ? (nodes.find((n) => n.type === 'camera')?.id ?? nodes[0]!.id)
            : s.activeCameraId;
        return { ...s, nodes, activeCameraId };
      });
      setSelectedId((prev) => (prev === id ? scene.activeCameraId : prev));
    },
    [scene.activeCameraId, setScene],
  );

  const duplicateNode = useCallback(
    (id: string) => {
      const src = scene.nodes.find((n) => n.id === id);
      if (!src) return;
      const copy = {
        ...structuredClone(src),
        id: newNodeId(src.type === 'camera' ? 'cam' : src.type === 'light' ? 'light' : src.type),
        name: `${src.name} copy`,
        transform: {
          ...src.transform,
          position: [
            src.transform.position[0] + 0.35,
            src.transform.position[1],
            src.transform.position[2],
          ] as SceneNode['transform']['position'],
        },
      } as SceneNode;
      addNode(copy);
    },
    [scene.nodes, addNode],
  );

  const toggleVisible = useCallback(
    (id: string) => {
      const n = scene.nodes.find((x) => x.id === id);
      if (n) updateNode(id, { visible: !n.visible });
    },
    [scene.nodes, updateNode],
  );

  const setActiveCamera = useCallback(
    (id: string) => {
      setScene((s) => ({ ...s, activeCameraId: id }));
    },
    [setScene],
  );

  const setNodeTransform = useCallback(
    (id: string, transform: SceneNode['transform']) => {
      // #region agent log
      const node = scene.nodes.find(n => n.id === id);
      fetch('http://127.0.0.1:7445/ingest/d520ae88-7e66-4f86-8787-69592b53c18f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'f4aab0'},body:JSON.stringify({sessionId:'f4aab0',location:'App.tsx:setNodeTransform',message:'setNodeTransform',data:{id,type:node?.type,scale:transform.scale},timestamp:Date.now(),hypothesisId:'C'})}).catch(()=>{});
      // #endregion
      updateNode(id, { transform });
    },
    [updateNode, scene.nodes],
  );

  const importGlb = useCallback(
    (file: File, assetKey: string, previewUrl: string) => {
      setImportBusy(true);
      const base = file.name.replace(/\.glb$/i, '').replace(/\.gltf$/i, '') || 'Imported';
      const id = newNodeId('prop');
      setAssetUrls((u) => ({ ...u, [assetKey]: previewUrl }));
      addNode({
        id,
        name: base,
        type: 'prop',
        assetKey,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        visible: true,
      });
      setImportBusy(false);
    },
    [addNode],
  );

  const handleSave = useCallback(() => {
    saveScene(scene);
    setError(null);
  }, [scene]);

  const handleRecord = useCallback(async () => {
    const ready = voices.filter((v) => v.status === 'ready');
    if (!voiceId || !ready.some((v) => v.id === voiceId)) {
      setError('Select or clone a voice first (Voice panel → Existing or Clone new)');
      return;
    }
    const emptyLines = emptyScriptLineIndices(segments);
    if (emptyLines.length > 0) {
      setScriptNeedsText(true);
      const lineLabel = emptyLines.length === 1 ? `Line ${emptyLines[0]}` : `Lines ${emptyLines.join(', ')}`;
      setError(`${lineLabel} need dialog text — type in Dialog & lip-sync below`);
      return;
    }
    setScriptNeedsText(false);
    setBusy(true);
    setError(null);
    try {
      let recordScene = scene;
      const viewportCam = viewportRef.current?.captureRecordCamera();
      if (viewportCam) {
        recordScene = {
          ...scene,
          nodes: scene.nodes.map((n) => {
            if (n.id !== scene.activeCameraId || n.type !== 'camera') return n;
            return { ...n, transform: viewportCam.transform, fov: viewportCam.fov };
          }),
        };
        setScene(recordScene);
      }
      const spec = sceneToEngineRenderSpec(recordScene, voiceId, {
        version: 1,
        language: 'en',
        segments,
      });
      const camNode = recordScene.nodes.find(
        (n) => n.type === 'camera' && n.id === recordScene.activeCameraId,
      );
      // #region agent log
      fetch('http://127.0.0.1:7445/ingest/d520ae88-7e66-4f86-8787-69592b53c18f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'f4aab0'},body:JSON.stringify({sessionId:'f4aab0',location:'App.tsx:handleRecord',message:'record start',data:{voiceId,avatarId:spec.avatarId,viewMode,cameraRotation:camNode?.type==='camera'?camNode.transform.rotation:null,viewportCaptured:!!viewportCam,hasScene:!!spec.scene},timestamp:Date.now(),hypothesisId:'camera-wysiwyg'})}).catch(()=>{});
      // #endregion
      const j = await api.createEngineJob(spec);
      setJob(j);
      setEvents([]);
    } catch (e) {
      // #region agent log
      fetch('http://127.0.0.1:7445/ingest/d520ae88-7e66-4f86-8787-69592b53c18f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'f4aab0'},body:JSON.stringify({sessionId:'f4aab0',location:'App.tsx:handleRecord',message:'record failed',data:{error:String(e)},timestamp:Date.now(),hypothesisId:'record-500'})}).catch(()=>{});
      // #endregion
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [scene, voiceId, voices, segments, viewMode, setScene]);

  const focusSelected = useCallback(() => {
    setFocusToken((n) => n + 1);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (mod && (e.key === 'Z' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && e.key === 's') {
        e.preventDefault();
        handleSave();
        return;
      }
      if (e.key === 'g' || e.key === 'G') {
        setTransformMode('translate');
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        setTransformMode('rotate');
        return;
      }
      if (e.key === 's' || e.key === 'S') {
        setTransformMode('scale');
        return;
      }
      if (e.key === 'f' || e.key === 'F') {
        focusSelected();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId) removeNode(selectedId);
        return;
      }
      if (e.key === 'd' && mod && selectedId) {
        e.preventDefault();
        duplicateNode(selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, handleSave, focusSelected, selectedId, removeNode, duplicateNode]);

  return (
    <div className="editor-root">
      <header className="topbar">
        <div className="brand">LiveAvatar Scene Editor</div>
        <span className="hint">Active camera = recorded view · bottom-left preview</span>
      </header>

      <Toolbar
        busy={busy}
        viewMode={viewMode}
        onViewMode={setViewMode}
        transformMode={transformMode}
        onTransformMode={setTransformMode}
        showGrid={showGrid}
        showAxes={showAxes}
        snapEnabled={snapEnabled}
        onToggleGrid={() => setShowGrid((v) => !v)}
        onToggleAxes={() => setShowAxes((v) => !v)}
        onToggleSnap={() => setSnapEnabled((v) => !v)}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        onFocusSelected={focusSelected}
        onSave={handleSave}
        onRecord={() => void handleRecord()}
        job={job}
        downloadUrl={job?.status === 'succeeded' ? api.engineJobDownloadUrl(job.id) : undefined}
      />

      {error && <div className="banner error">{error}</div>}

      <div className="workspace">
        <aside className="panel left">
          <div className="panel-scroll">
            <SceneGraph
              scene={scene}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onRenameScene={(name) => setScene((s) => ({ ...s, name }))}
              onAdd={addNode}
              onRemove={removeNode}
              onDuplicate={duplicateNode}
              onToggleVisible={toggleVisible}
              onSetActiveCamera={setActiveCamera}
              onImportGlb={importGlb}
              importBusy={importBusy}
            />
          </div>
        </aside>

        <section className="viewport-wrap">
          <Viewport
            ref={viewportRef}
            scene={scene}
            selectedId={selectedId}
            viewMode={viewMode}
            transformMode={transformMode}
            showGrid={showGrid}
            showAxes={showAxes}
            snapEnabled={snapEnabled}
            focusToken={focusToken}
            lipSyncDemo={lipSyncDemo}
            assetUrls={assetUrls}
            onSelect={setSelectedId}
            onNodeTransform={setNodeTransform}
          />
        </section>

        <aside className="panel right">
          <div className="panel-scroll">
            <Inspector
              node={selected}
              lipSyncDemo={lipSyncDemo}
              onLipSyncDemo={setLipSyncDemo}
              onChange={(patch) => selected && updateNode(selected.id, patch)}
            />
            <VoicePanel
              voices={voices}
              voiceId={voiceId}
              onVoiceId={setVoiceId}
              onVoicesChanged={refreshVoices}
              onVoiceUpsert={upsertVoice}
              cloneBusy={cloneBusy}
              onCloneBusy={setCloneBusy}
              onError={setError}
            />
            <ScriptPanel
              segments={segments}
              onSegments={(s) => {
                setSegments(s);
                if (scriptNeedsText && emptyScriptLineIndices(s).length === 0) {
                  setScriptNeedsText(false);
                  setError(null);
                }
              }}
              highlightEmpty={scriptNeedsText}
            />
            {job && (
              <div className="card job-card">
                <strong>Job</strong>
                <code className="job-id">{job.id}</code>
                <span className={`badge ${job.status}`}>{job.status}</span>
                {(job.status === 'tts' ||
                  job.status === 'running' ||
                  job.status === 'compiling' ||
                  job.status === 'rendering' ||
                  job.status === 'succeeded') && (
                  <p className="muted job-hint">
                    Manifest:{' '}
                    <a href={api.engineJobManifestUrl(job.id)} target="_blank" rel="noreferrer">
                      {api.engineJobManifestUrl(job.id)}
                    </a>
                    {(job.status === 'tts' || job.status === 'compiling') &&
                      ' — available after TTS finishes (~10s)'}
                  </p>
                )}
                <ul>
                  {events.slice(-6).map((e) => (
                    <li key={e.id}>
                      {e.status ?? e.kind}
                      {e.progress != null ? ` ${Math.round(e.progress * 100)}%` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </aside>
      </div>

      <StatusBar
        sceneName={scene.name}
        nodeCount={scene.nodes.length}
        selected={selected}
        transformMode={transformMode}
        snapEnabled={snapEnabled}
        viewMode={viewMode}
      />
    </div>
  );
}
