import { useRef, useState } from 'react';

interface Props {
  video?: boolean;
  audio?: boolean;
  disabled?: boolean;
  onRecorded: (blob: Blob) => void;
}

/** Minimal webcam/mic recorder used by the avatar + voice creation flows. */
export function MediaRecorderBox({ video, audio, disabled, onRecorded }: Props) {
  const previewRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: !!video, audio: !!audio });
      streamRef.current = stream;
      if (previewRef.current && video) {
        previewRef.current.srcObject = stream;
        await previewRef.current.play().catch(() => {});
      }
      chunksRef.current = [];
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: video ? 'video/webm' : 'audio/webm',
        });
        stream.getTracks().forEach((t) => t.stop());
        onRecorded(blob);
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
    } catch (e) {
      setError(String(e));
    }
  }

  function stop() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  return (
    <div>
      {video && <video ref={previewRef} muted playsInline style={{ maxHeight: 220 }} />}
      <div className="row" style={{ marginTop: 8 }}>
        {!recording ? (
          <button className="btn secondary" disabled={disabled} onClick={start}>
            Start recording
          </button>
        ) : (
          <button className="btn" onClick={stop}>
            Stop &amp; use
          </button>
        )}
      </div>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
    </div>
  );
}
