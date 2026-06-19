import { SceneDocument } from '@las/protocol';

const KEY = 'las-scene-editor-v1';

export function loadScene(): SceneDocument | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return SceneDocument.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveScene(doc: SceneDocument): void {
  localStorage.setItem(KEY, JSON.stringify(doc));
}
