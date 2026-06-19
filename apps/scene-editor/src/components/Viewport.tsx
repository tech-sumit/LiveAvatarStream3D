import type { SceneDocument, SceneNode, Transform } from '@las/protocol';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { TransformMode } from './StatusBar.js';
import { snapTransform } from '../lib/snap.js';
import {
  AmbientLight,
  AxesHelper,
  Box3,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Raycaster,
  Scene,
  SkinnedMesh,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { createEditorGltfLoader } from '../lib/editorGltfLoader.js';
import { loadAvatarPreview, updateAvatarMixers, type AvatarDecalMap, type AvatarMixerMap } from '../lib/loadAvatarPreview.js';
import { updateDecalLipsync } from '../lib/decalLipsync.js';

interface Props {
  scene: SceneDocument;
  selectedId: string;
  viewMode: 'editor' | 'activeCamera';
  transformMode: TransformMode;
  showGrid: boolean;
  showAxes: boolean;
  snapEnabled: boolean;
  focusToken: number;
  lipSyncDemo: boolean;
  assetUrls: Record<string, string>;
  onSelect: (id: string) => void;
  onNodeTransform: (id: string, transform: Transform) => void;
}

export type ViewportHandle = {
  /** Main viewport camera at Record time — matches what the user sees. */
  captureRecordCamera(): { transform: Transform; fov: number } | null;
};

function cameraToTransform(cam: PerspectiveCamera): Transform {
  return {
    position: [cam.position.x, cam.position.y, cam.position.z],
    rotation: [radToDeg(cam.rotation.x), radToDeg(cam.rotation.y), radToDeg(cam.rotation.z)],
    scale: [1, 1, 1],
  };
}

function degToRad(d: number): number {
  return (d * Math.PI) / 180;
}

function radToDeg(r: number): number {
  return (r * 180) / Math.PI;
}

function layoutScaleOf(obj: Object3D): number {
  return (obj.userData.layoutScale as number | undefined) ?? 1;
}

function refreshSkinnedMeshes(root: Object3D): void {
  root.traverse((child) => {
    if (child instanceof SkinnedMesh && child.skeleton) {
      child.skeleton.update();
    }
  });
}

function applyTransform(obj: Object3D, t: Transform): void {
  obj.position.set(t.position[0], t.position[1], t.position[2]);
  obj.rotation.set(degToRad(t.rotation[0]), degToRad(t.rotation[1]), degToRad(t.rotation[2]));
  const layout = layoutScaleOf(obj);
  obj.scale.set(t.scale[0] * layout, t.scale[1] * layout, t.scale[2] * layout);
  obj.updateMatrixWorld(true);
  refreshSkinnedMeshes(obj);
  // #region agent log
  if (obj.userData.nodeId) {
    const box = new Box3().setFromObject(obj);
    const worldH = box.getSize(new Vector3()).y;
    fetch('http://127.0.0.1:7445/ingest/d520ae88-7e66-4f86-8787-69592b53c18f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'f4aab0'},body:JSON.stringify({sessionId:'f4aab0',location:'Viewport.tsx:applyTransform',message:'applyTransform',data:{nodeId:obj.userData.nodeId,localScale:[obj.scale.x,obj.scale.y,obj.scale.z],requestedScale:t.scale,layoutScale:layout,worldHeight:worldH,childCount:obj.children.length},timestamp:Date.now(),runId:'post-fix',hypothesisId:'B-E'})}).catch(()=>{});
  }
  // #endregion
}

function transformFromObject(obj: Object3D): Transform {
  const layout = layoutScaleOf(obj);
  return {
    position: [obj.position.x, obj.position.y, obj.position.z],
    rotation: [radToDeg(obj.rotation.x), radToDeg(obj.rotation.y), radToDeg(obj.rotation.z)],
    scale: [obj.scale.x / layout, obj.scale.y / layout, obj.scale.z / layout],
  };
}

function sceneStructureKey(doc: SceneDocument): string {
  return JSON.stringify({
    activeCameraId: doc.activeCameraId,
    background: doc.stage.background,
    nodes: doc.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      visible: n.visible,
      ...(n.type === 'avatar' ? { avatarId: n.avatarId } : {}),
      ...(n.type === 'prop' ? { assetKey: n.assetKey } : {}),
      ...(n.type === 'light'
        ? { lightType: n.lightType, color: n.color, intensity: n.intensity }
        : {}),
      ...(n.type === 'camera' ? { fov: n.fov, near: n.near, far: n.far } : {}),
    })),
  });
}

function buildPlaceholder(node: SceneNode, selected: boolean): Object3D {
  if (node.type === 'avatar') {
    const root = new Group();
    const body = new Mesh(
      new CylinderGeometry(0.25, 0.3, 1.75, 16),
      new MeshStandardMaterial({ color: selected ? 0xffcc88 : 0xe8c4a8 }),
    );
    body.position.y = 0.875;
    const head = new Mesh(
      new BoxGeometry(0.28, 0.28, 0.28),
      new MeshStandardMaterial({ color: selected ? 0xffddaa : 0xf0d0b8 }),
    );
    head.position.y = 1.85;
    root.add(body, head);
    return root;
  }

  if (node.type === 'prop') {
    const isFloor = node.assetKey === '__builtin_floor__';
    const geo = isFloor ? new PlaneGeometry(12, 12) : new BoxGeometry(0.5, 0.5, 0.5);
    const mat = new MeshStandardMaterial({
      color: isFloor ? 0x2a3040 : selected ? 0x88aaff : 0x8899aa,
      side: isFloor ? DoubleSide : 0,
    });
    const m = new Mesh(geo, mat);
    if (isFloor) m.rotation.x = -Math.PI / 2;
    return m;
  }

  if (node.type === 'light') {
    return new Mesh(
      new BoxGeometry(0.15, 0.15, 0.15),
      new MeshStandardMaterial({ color: 0xffff88, emissive: 0xffff44 }),
    );
  }

  return new Mesh(
    new BoxGeometry(0.2, 0.12, 0.3),
    new MeshStandardMaterial({ color: selected ? 0x66ff66 : 0x44aa44 }),
  );
}

function syncActiveCamera(cam: PerspectiveCamera, node: Extract<SceneNode, { type: 'camera' }>): void {
  cam.fov = node.fov;
  cam.near = node.near;
  cam.far = node.far;
  applyTransform(cam, node.transform);
  cam.updateProjectionMatrix();
}

function resolvePreviewCamera(
  doc: SceneDocument,
  selectedId: string,
): Extract<SceneNode, { type: 'camera' }> | null {
  const selected = doc.nodes.find((n) => n.id === selectedId && n.type === 'camera');
  if (selected?.type === 'camera') return selected;
  const active = doc.nodes.find((n) => n.id === doc.activeCameraId && n.type === 'camera');
  return active?.type === 'camera' ? active : null;
}

export const Viewport = forwardRef<ViewportHandle, Props>(function Viewport(
  {
    scene,
    selectedId,
    viewMode,
    transformMode,
    showGrid,
    showAxes,
    snapEnabled,
    focusToken,
    lipSyncDemo,
    assetUrls,
    onSelect,
    onNodeTransform,
  },
  ref,
) {
  const mountRef = useRef<HTMLDivElement>(null);
  const previewMountRef = useRef<HTMLDivElement>(null);
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const transformModeRef = useRef(transformMode);
  transformModeRef.current = transformMode;
  const snapEnabledRef = useRef(snapEnabled);
  snapEnabledRef.current = snapEnabled;
  const lipSyncDemoRef = useRef(lipSyncDemo);
  lipSyncDemoRef.current = lipSyncDemo;
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onNodeTransformRef = useRef(onNodeTransform);
  onNodeTransformRef.current = onNodeTransform;
  const assetUrlsRef = useRef(assetUrls);
  assetUrlsRef.current = assetUrls;
  const buildGenerationRef = useRef(0);
  const [sceneReady, setSceneReady] = useState(0);

  useImperativeHandle(
    ref,
    () => ({
      captureRecordCamera() {
        const st = stateRef.current;
        if (!st) return null;
        const cam = viewModeRef.current === 'activeCamera' ? st.activeCam : st.editorCam;
        return { transform: cameraToTransform(cam), fov: cam.fov };
      },
    }),
    [sceneReady],
  );

  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    st.controls.enabled = viewMode === 'editor';
  }, [viewMode, sceneReady]);

  const stateRef = useRef<{
    renderer: WebGLRenderer;
    threeScene: Scene;
    editorCam: PerspectiveCamera;
    activeCam: PerspectiveCamera;
    controls: OrbitControls;
    transform: TransformControls;
    nodeObjects: Map<string, Object3D>;
    lights: Map<string, Object3D>;
    gltfLoader: Awaited<ReturnType<typeof createEditorGltfLoader>>;
    gltfCache: Map<string, Object3D>;
    avatarCache: Map<string, { scene: Group; animations: import('three').AnimationClip[] }>;
    avatarMixers: AvatarMixerMap;
    avatarDecals: AvatarDecalMap;
    previewRenderer: WebGLRenderer;
    previewCam: PerspectiveCamera;
    gridHelper: GridHelper;
    axesHelper: AxesHelper;
  } | null>(null);

  // Mount once: renderer, controls, transform gizmo, animation loop.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let cancelled = false;
    let lastFrameMs = performance.now();
    let disposeMount: (() => void) | null = null;

    void (async () => {
      const gltfLoader = await createEditorGltfLoader();
      if (cancelled) return;

      const renderer = new WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const threeScene = new Scene();
    const editorCam = new PerspectiveCamera(50, mount.clientWidth / mount.clientHeight, 0.1, 200);
    editorCam.position.set(2.5, 2, 4);
    editorCam.lookAt(0, 1.2, 0);

    const activeCam = new PerspectiveCamera(50, mount.clientWidth / mount.clientHeight, 0.1, 200);

    const PREVIEW_W = 280;
    const PREVIEW_H = 158;
    const previewRenderer = new WebGLRenderer({ antialias: true, alpha: true });
    previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    previewRenderer.setSize(PREVIEW_W, PREVIEW_H);
    const previewCam = new PerspectiveCamera(50, PREVIEW_W / PREVIEW_H, 0.1, 200);
    const previewMount = previewMountRef.current;
    if (previewMount) previewMount.appendChild(previewRenderer.domElement);

    const orbit = new OrbitControls(editorCam, renderer.domElement);
    orbit.target.set(0, 1.2, 0);
    orbit.enableDamping = true;

    const transform = new TransformControls(editorCam, renderer.domElement);
    transform.addEventListener('dragging-changed', (ev) => {
      const dragging = (ev as unknown as { value: boolean }).value;
      orbit.enabled = !dragging;
      if (!dragging) {
        const obj = transform.object;
        const id = obj?.userData.nodeId as string | undefined;
        if (!id || !obj) return;
        const node = sceneRef.current.nodes.find((n) => n.id === id);
        if (node) applyTransform(obj, node.transform);
      }
    });
    transform.addEventListener('objectChange', () => {
      const obj = transform.object;
      const id = obj?.userData.nodeId as string | undefined;
      if (!id || !obj) return;
      let t = transformFromObject(obj);
      // #region agent log
      fetch('http://127.0.0.1:7445/ingest/d520ae88-7e66-4f86-8787-69592b53c18f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'f4aab0'},body:JSON.stringify({sessionId:'f4aab0',location:'Viewport.tsx:objectChange',message:'gizmo objectChange',data:{nodeId:id,scale:t.scale,mode:transformModeRef.current,dragging:transform.dragging},timestamp:Date.now(),runId:'post-fix',hypothesisId:'C'})}).catch(()=>{});
      // #endregion
      if (snapEnabledRef.current) {
        t = snapTransform(t, 0.25);
        const light = stateRef.current?.lights.get(id);
        if (light) applyTransform(light, t);
      }
      applyTransform(obj, t);
      onNodeTransformRef.current(id, t);
    });
    threeScene.add(transform);

    const gridHelper = new GridHelper(12, 24, 0x334455, 0x222833);
    const axesHelper = new AxesHelper(1.5);
    threeScene.add(gridHelper);
    threeScene.add(axesHelper);
    threeScene.add(new AmbientLight(0x666666, 1));
    const keyLight = new DirectionalLight(0xffddcc, 2.5);
    keyLight.position.set(2, 3, 2);
    threeScene.add(keyLight);
    const fillLight = new DirectionalLight(0xccccff, 1.5);
    fillLight.position.set(-2, 2, -1);
    threeScene.add(fillLight);

    stateRef.current = {
      renderer,
      threeScene,
      editorCam,
      activeCam,
      controls: orbit,
      transform,
      nodeObjects: new Map(),
      lights: new Map(),
      gltfLoader,
      gltfCache: new Map(),
      avatarCache: new Map(),
      avatarMixers: new Map(),
      avatarDecals: new Map(),
      previewRenderer,
      previewCam,
      gridHelper,
      axesHelper,
    };
    setSceneReady((n) => n + 1);

    const raycaster = new Raycaster();
    const pointer = new Vector2();

    const pickNode = (ev: PointerEvent) => {
      const st = stateRef.current;
      if (!st || transform.dragging) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      const cam = viewModeRef.current === 'activeCamera' ? st.activeCam : st.editorCam;
      raycaster.setFromCamera(pointer, cam);
      const hits = raycaster.intersectObjects([...st.nodeObjects.values()], true);
      for (const hit of hits) {
        let o: Object3D | null = hit.object;
        while (o) {
          const id = o.userData.nodeId as string | undefined;
          if (id) {
            onSelectRef.current(id);
            return;
          }
          o = o.parent;
        }
      }
    };

    renderer.domElement.addEventListener('pointerdown', pickNode);

    const onResize = () => {
      const st = stateRef.current;
      if (!st || !mount) return;
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      st.renderer.setSize(w, h);
      st.editorCam.aspect = w / h;
      st.editorCam.updateProjectionMatrix();
      st.activeCam.aspect = w / h;
      st.activeCam.updateProjectionMatrix();
    };
    window.addEventListener('resize', onResize);

    let frameId = 0;
    const tick = () => {
      frameId = requestAnimationFrame(tick);
      const st = stateRef.current;
      if (!st) return;
      const now = performance.now();
      const deltaS = Math.min(0.05, (now - lastFrameMs) / 1000);
      lastFrameMs = now;
      updateAvatarMixers(st.avatarMixers, deltaS);
      for (const c of st.avatarDecals.values()) {
        c.setActive(lipSyncDemoRef.current);
      }
      updateDecalLipsync(st.avatarDecals, deltaS);
      st.controls.update();
      const cam = viewModeRef.current === 'activeCamera' ? st.activeCam : st.editorCam;
      st.renderer.render(st.threeScene, cam);

      const previewNode = resolvePreviewCamera(sceneRef.current, selectedIdRef.current);
      if (previewNode) {
        syncActiveCamera(st.previewCam, previewNode);
        st.previewRenderer.render(st.threeScene, st.previewCam);
      }
    };
    tick();

    disposeMount = () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener('resize', onResize);
      renderer.domElement.removeEventListener('pointerdown', pickNode);
      transform.dispose();
      orbit.dispose();
      renderer.dispose();
      const st = stateRef.current;
      if (st) {
        st.avatarMixers.clear();
        for (const d of st.avatarDecals.values()) d.dispose();
        st.avatarDecals.clear();
        st.previewRenderer.dispose();
        const pm = previewMountRef.current;
        if (pm?.contains(st.previewRenderer.domElement)) {
          pm.removeChild(st.previewRenderer.domElement);
        }
      }
      mount.removeChild(renderer.domElement);
      stateRef.current = null;
    };
    })();

    return () => {
      cancelled = true;
      disposeMount?.();
    };
  }, []);

  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    st.transform.setMode(transformMode);
  }, [transformMode]);

  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    st.gridHelper.visible = showGrid;
    st.axesHelper.visible = showAxes;
  }, [showGrid, showAxes]);

  useEffect(() => {
    const st = stateRef.current;
    if (!st || focusToken === 0) return;
    const obj = st.nodeObjects.get(selectedIdRef.current);
    if (!obj) return;
    const box = new Box3().setFromObject(obj);
    if (box.isEmpty()) return;
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.5);
    const dist = maxDim * 2.2;
    st.controls.target.copy(center);
    st.editorCam.position.set(center.x + dist * 0.6, center.y + dist * 0.35, center.z + dist);
    st.editorCam.lookAt(center);
    st.controls.update();
  }, [focusToken]);

  const structureKey = sceneStructureKey(scene);

  // Rebuild scene objects when graph structure changes (not on every transform tweak).
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;

    const doc = sceneRef.current;
    const sel = selectedIdRef.current;
    const buildGen = ++buildGenerationRef.current;
    // #region agent log
    fetch('http://127.0.0.1:7445/ingest/d520ae88-7e66-4f86-8787-69592b53c18f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'f4aab0'},body:JSON.stringify({sessionId:'f4aab0',location:'Viewport.tsx:rebuildEffect',message:'structure rebuild start',data:{buildGen,structureKey},timestamp:Date.now(),hypothesisId:'D'})}).catch(()=>{});
    // #endregion

    const { threeScene, activeCam, nodeObjects, lights, transform, gltfLoader, gltfCache, avatarCache, avatarMixers, avatarDecals } = st;
    threeScene.background = new Color(doc.stage.background);

    avatarMixers.clear();
    for (const d of avatarDecals.values()) d.dispose();
    avatarDecals.clear();

    for (const obj of nodeObjects.values()) threeScene.remove(obj);
    nodeObjects.clear();
    for (const light of lights.values()) threeScene.remove(light);
    lights.clear();

    void (async () => {
      for (const node of doc.nodes) {
        if (!node.visible) continue;

        if (node.type === 'light') {
          const col = new Color(node.color);
          let light: AmbientLight | DirectionalLight | HemisphereLight | PointLight;
          switch (node.lightType) {
            case 'ambient':
              light = new AmbientLight(col, node.intensity);
              break;
            case 'hemisphere':
              light = new HemisphereLight(col, 0x444444, node.intensity);
              break;
            case 'point':
              light = new PointLight(col, node.intensity);
              break;
            default:
              light = new DirectionalLight(col, node.intensity);
          }
          applyTransform(light, node.transform);
          lights.set(node.id, light);
          threeScene.add(light);
          const helper = buildPlaceholder(node, node.id === sel);
          helper.userData.nodeId = node.id;
          applyTransform(helper, node.transform);
          nodeObjects.set(node.id, helper);
          threeScene.add(helper);
          continue;
        }

        if (node.type === 'camera') {
          if (node.id === doc.activeCameraId) {
            syncActiveCamera(activeCam, node);
          }
          const helper = buildPlaceholder(node, node.id === sel);
          helper.userData.nodeId = node.id;
          applyTransform(helper, node.transform);
          nodeObjects.set(node.id, helper);
          threeScene.add(helper);
          continue;
        }

        let visual: Object3D;

        if (node.type === 'avatar') {
          try {
            const { root, mixer, lipsync } = await loadAvatarPreview(gltfLoader, node.avatarId, avatarCache);
            if (buildGen !== buildGenerationRef.current) return;
            visual = root;
            visual.userData.nodeId = node.id;
            if (mixer) avatarMixers.set(node.id, mixer);
            if (lipsync) avatarDecals.set(node.id, lipsync);
          } catch {
            visual = buildPlaceholder(node, node.id === sel);
            visual.userData.nodeId = node.id;
          }
        } else {
          const url = node.type === 'prop' ? assetUrlsRef.current[node.assetKey] : undefined;
          if (node.type === 'prop' && url && node.assetKey !== '__builtin_floor__') {
            if (gltfCache.has(node.assetKey)) {
              visual = gltfCache.get(node.assetKey)!.clone();
            } else {
              try {
                const gltf = await gltfLoader.loadAsync(url);
                if (buildGen !== buildGenerationRef.current) return;
                gltfCache.set(node.assetKey, gltf.scene);
                visual = gltf.scene.clone();
              } catch {
                visual = buildPlaceholder(node, node.id === sel);
              }
            }
          } else {
            visual = buildPlaceholder(node, node.id === sel);
          }
          visual.userData.nodeId = node.id;
        }

        applyTransform(visual, node.transform);
        nodeObjects.set(node.id, visual);
        threeScene.add(visual);
      }

      if (buildGen !== buildGenerationRef.current) return;

      const selectedObj = nodeObjects.get(sel);
      if (selectedObj && selectedObj !== transform.object) {
        transform.attach(selectedObj);
      } else if (!selectedObj) {
        transform.detach();
      }
    })();
  }, [structureKey, selectedId, assetUrls, sceneReady]);

  // Apply transform edits in place — avoids reloading avatars on scale/translate/rotate.
  useEffect(() => {
    const st = stateRef.current;
    // #region agent log
    fetch('http://127.0.0.1:7445/ingest/d520ae88-7e66-4f86-8787-69592b53c18f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'f4aab0'},body:JSON.stringify({sessionId:'f4aab0',location:'Viewport.tsx:syncEffect',message:'transform sync effect',data:{hasState:!!st,dragging:st?.transform.dragging??null,nodeObjectCount:st?.nodeObjects.size??0,avatarScales:scene.nodes.filter(n=>n.type==='avatar').map(n=>({id:n.id,scale:n.transform.scale}))},timestamp:Date.now(),hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    if (!st || st.transform.dragging) return;

    const { activeCam, nodeObjects, lights } = st;
    for (const node of scene.nodes) {
      const obj = nodeObjects.get(node.id);
      if (!obj) continue;
      applyTransform(obj, node.transform);
      if (node.type === 'light') {
        const light = lights.get(node.id);
        if (light) applyTransform(light, node.transform);
      }
      if (node.type === 'camera' && node.id === scene.activeCameraId) {
        syncActiveCamera(activeCam, node);
      }
    }
  }, [scene]);

  const previewCamNode = resolvePreviewCamera(scene, selectedId);
  const previewLabel = previewCamNode?.name ?? 'Camera view';
  const isSelectedCam = previewCamNode?.id === selectedId && previewCamNode.type === 'camera';

  return (
    <div className="viewport">
      <div ref={mountRef} className="viewport-canvas" />
      <div className="camera-preview">
        <div className="camera-preview-header">
          <span className="camera-preview-title">{previewLabel}</span>
          {isSelectedCam ? (
            <span className="camera-preview-badge">selected</span>
          ) : (
            <span className="camera-preview-badge active">main</span>
          )}
        </div>
        <div ref={previewMountRef} className="camera-preview-canvas" />
      </div>
      <div className="viewport-overlay">
        {viewMode === 'activeCamera'
          ? 'Active camera · Record uses this view · gizmo/Inspector to move'
          : 'Editor orbit · Record uses this view · orbit or select Main Camera'}
      </div>
    </div>
  );
});
