import type { SceneDocument } from '@las/protocol';
import { useCallback, useRef, useState } from 'react';

const MAX_HISTORY = 20;

export function useSceneHistory(initial: SceneDocument) {
  const [scene, setSceneState] = useState(initial);
  const past = useRef<SceneDocument[]>([]);
  const future = useRef<SceneDocument[]>([]);
  const [historyTick, setHistoryTick] = useState(0);
  const [undoLen, setUndoLen] = useState(0);
  const [redoLen, setRedoLen] = useState(0);

  const syncLens = () => {
    setUndoLen(past.current.length);
    setRedoLen(future.current.length);
    setHistoryTick((n) => n + 1);
  };

  const setScene = useCallback(
    (updater: SceneDocument | ((prev: SceneDocument) => SceneDocument), recordHistory = true) => {
      setSceneState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        if (recordHistory && next !== prev) {
          past.current = [...past.current.slice(-(MAX_HISTORY - 1)), structuredClone(prev)];
          future.current = [];
          syncLens();
        }
        return next;
      });
    },
    [],
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    setSceneState((current) => {
      future.current.push(structuredClone(current));
      syncLens();
      return prev;
    });
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    setSceneState((current) => {
      past.current.push(structuredClone(current));
      syncLens();
      return next;
    });
  }, []);

  const canUndo = undoLen > 0;
  const canRedo = redoLen > 0;

  void historyTick;

  return { scene, setScene, undo, redo, canUndo, canRedo };
}
