import jsQR from 'jsqr';
import { type OfflineBundle, type OfflineManifest } from '@eventflow/event-contracts';
import { hash, verifyManifest, provisionalEligibility, type GateContext } from './crypto';
type Request = { id: number } & (
  | {
      type: 'INIT';
      bundle: OfflineBundle;
      keyId: string;
      publicKey: CryptoKey;
      context: GateContext;
    }
  | { type: 'CHECK'; credential: string; now: number }
  | { type: 'FRAME'; pixels: ArrayBuffer; width: number; height: number }
);
let manifest: OfflineManifest | undefined,
  revision = 0;
self.addEventListener('message', (event: MessageEvent<Request>) => {
  void handle(event.data)
    .then((value) => self.postMessage({ id: event.data.id, value }))
    .catch((error) => {
      self.postMessage({
        id: event.data.id,
        error: error instanceof Error ? error.message : 'Проверка недоступна.',
      });
    });
});
async function handle(request: Request) {
  if (request.type === 'INIT') {
    const current = ++revision,
      result = await verifyManifest(
        request.bundle,
        request.keyId,
        request.publicKey,
        request.context,
      );
    if (current !== revision) throw new Error('Снимок уже изменился.');
    manifest = result;
    return result;
  }
  if (request.type === 'FRAME') {
    if (
      request.width < 1 ||
      request.height < 1 ||
      request.width > 640 ||
      request.height > 640 ||
      request.pixels.byteLength !== request.width * request.height * 4
    )
      throw new Error('Неверный кадр камеры.');
    const result = jsQR(new Uint8ClampedArray(request.pixels), request.width, request.height, {
      inversionAttempts: 'dontInvert',
    });
    return result && /^[A-Za-z0-9_-]{32}$/.test(result.data) ? result.data : null;
  }
  if (!manifest) throw new Error('Сначала подготовьте мероприятие.');
  if (!/^[A-Za-z0-9_-]{32}$/.test(request.credential)) throw new Error('Неверный формат кода.');
  const credentialHash = await hash(request.credential);
  if (!provisionalEligibility(manifest, credentialHash, request.now))
    throw new Error('Билет отсутствует в подготовленном снимке.');
  return credentialHash;
}
