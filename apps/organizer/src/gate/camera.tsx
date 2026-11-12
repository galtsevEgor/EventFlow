import { useEffect, useRef, useState } from 'react';
import { Alert } from '@eventflow/ui';
import { type ScannerWorker } from './worker-client';

const OFFLINE_CAMERA_SCAN_INTERVAL_MS = 160;

export function GateCamera({
  worker,
  onCode,
}: {
  worker: ScannerWorker;
  onCode: (code: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let stopped = false,
      stream: MediaStream | undefined,
      timer: ReturnType<typeof setInterval> | undefined,
      busy = false;
    const stop = () => {
      stopped = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      element.srcObject = null;
    };
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' } },
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        for (const track of stream.getVideoTracks())
          track.addEventListener(
            'ended',
            () => {
              stop();
              setFailed(true);
            },
            { once: true },
          );
        element.srcObject = stream;
        await element.play();
        if (stopped) return;
        const canvas = document.createElement('canvas'),
          context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Canvas unavailable');
        timer = setInterval(() => {
          if (busy || stopped || element.readyState < 2 || !element.videoWidth) return;
          const ratio = Math.min(640 / element.videoWidth, 640 / element.videoHeight, 1);
          canvas.width = Math.round(element.videoWidth * ratio);
          canvas.height = Math.round(element.videoHeight * ratio);
          context.drawImage(element, 0, 0, canvas.width, canvas.height);
          busy = true;
          void worker
            .frame(context.getImageData(0, 0, canvas.width, canvas.height))
            .then((code) => {
              if (code && !stopped) {
                stop();
                onCode(code);
              }
            })
            .catch(() => {
              if (!stopped) {
                stop();
                setFailed(true);
              }
            })
            .finally(() => {
              busy = false;
            });
        }, OFFLINE_CAMERA_SCAN_INTERVAL_MS);
      } catch {
        if (!stopped) {
          stop();
          setFailed(true);
        }
      }
    })();
    return stop;
  }, [worker, onCode]);
  return failed ? (
    <Alert>Камера недоступна. Введите код вручную.</Alert>
  ) : (
    <video className="check-in-video" ref={video} playsInline muted aria-label="Камера сканера" />
  );
}
