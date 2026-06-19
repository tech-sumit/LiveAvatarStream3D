import { useRef, useState } from 'react';

interface Props {
  disabled?: boolean;
  onRecorded: (blob: Blob) => void;
}

/** Mic recorder for voice clone samples (10–30s). */
export function MediaRecorderBox({ disabled, onRecorded }: Props) {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const timerRef = useRef<number | null>(null);

  async function start() {
    setError(null);
    setSeconds(0);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const rec = new MediaRecorder(stream, { mimeType });
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        if (timerRef.current) {
          window.clearInterval(timerRef.current);
          timerRef.current = null;
        }
        const blob = new Blob(chunksRef.current, { type: mimeType });
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        onRecorded(blob);
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
      timerRef.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch (e) {
      setError(String(e));
    }
  }

  function stop() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  return (
    <div className="voice-recorder">
      <div className="row">
        {!recording ? (
          <button type="button" className="btn sm secondary" disabled={disabled} onClick={start}>
            Record sample
          </button>
        ) : (
          <>
            <button type="button" className="btn sm" onClick={stop}>
              Stop &amp; use
            </button>
            <span className="rec-dot" aria-hidden />
            <span className="muted">{seconds}s</span>
          </>
        )}
      </div>
      {error && <p className="rec-error">{error}</p>}
    </div>
  );
}
