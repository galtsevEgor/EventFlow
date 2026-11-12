import { useEffect, useRef, useState } from 'react';
import { Alert } from '@eventflow/ui';
import jsQR from 'jsqr';

const ONLINE_CAMERA_SCAN_INTERVAL_MS = 160;

export function CheckInCamera({ onCode }: { onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'STARTING' | 'READY' | 'FAILED'>('STARTING');

  useEffect(() => {
    const preview = video.current;
    if (!preview) return;
    let cancelled = false;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      cancelled = true;
      clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
      preview.srcObject = null;
    };
    const fail = () => {
      if (!cancelled) setState('FAILED');
      stop();
    };
    async function start(element: HTMLVideoElement) {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' } },
        });
        stream = media;
        if (cancelled) return stop();
        for (const track of media.getVideoTracks())
          track.addEventListener('ended', fail, { once: true });
        element.srcObject = media;
        await element.play();
        if (cancelled) return;
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Canvas unavailable');
        setState('READY');
        timer = setInterval(() => {
          if (!element.videoWidth || element.readyState < 2) return;
          const width = Math.min(640, element.videoWidth);
          const height = Math.round((width * element.videoHeight) / element.videoWidth);
          if (canvas.width !== width) canvas.width = width;
          if (canvas.height !== height) canvas.height = height;
          context.drawImage(element, 0, 0, width, height);
          const frame = context.getImageData(0, 0, width, height);
          const result = jsQR(frame.data, width, height, { inversionAttempts: 'dontInvert' });
          if (result && /^[A-Za-z0-9_-]{32}$/.test(result.data)) {
            stop();
            onCode(result.data);
          }
        }, ONLINE_CAMERA_SCAN_INTERVAL_MS);
      } catch {
        fail();
      }
    }
    void start(preview);
    return stop;
  }, [onCode]);

  return (
    <>
      <video ref={video} className="check-in-video" playsInline muted hidden={state !== 'READY'} />
      {state === 'STARTING' && <p role="status">Открываем камеру…</p>}
      {state === 'FAILED' && <Alert>Камера недоступна. Введите код билета вручную.</Alert>}
    </>
  );
}
