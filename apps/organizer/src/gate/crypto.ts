import {
  offlineBundleSchema,
  offlineManifestSchema,
  offlinePublicKeySchema,
  type OfflineBundle,
  type OfflineManifest,
} from '@eventflow/event-contracts';
const encoder = new TextEncoder();
export function decode64(input: string): Uint8Array<ArrayBuffer> {
  const text = atob(input.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}
export function encode64(input: ArrayBuffer | Uint8Array<ArrayBuffer>) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
export async function hash(value: string | Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    typeof value === 'string' ? encoder.encode(value) : value,
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function importPublicKey(input: unknown) {
  const data = offlinePublicKeySchema.parse(input),
    raw = decode64(data.jwk.x);
  if ((await hash(raw)) !== data.id) throw new Error('Ключ снимка повреждён.');
  const key = await crypto.subtle.importKey('raw', raw, 'Ed25519', false, ['verify']);
  return { id: data.id, key };
}
export type GateContext = {
  actorSubject: string;
  organizationId: string;
  eventId: string;
  deviceId: string;
};
export async function verifyManifest(
  input: OfflineBundle,
  keyId: string,
  key: CryptoKey,
  context: GateContext,
) {
  const bundle = offlineBundleSchema.parse(input);
  if (
    bundle.keyId !== keyId ||
    !(await crypto.subtle.verify(
      'Ed25519',
      key,
      decode64(bundle.signature),
      encoder.encode(bundle.payload),
    ))
  )
    throw new Error('Подпись снимка недействительна.');
  const manifest = offlineManifestSchema.parse(JSON.parse(bundle.payload));
  for (const field of ['actorSubject', 'organizationId', 'eventId', 'deviceId'] as const)
    if (manifest[field] !== context[field])
      throw new Error('Снимок относится к другому аккаунту или мероприятию.');
  if (new Set(manifest.hashes).size !== manifest.hashes.length)
    throw new Error('Снимок содержит повторяющиеся билеты.');
  if (
    Date.parse(manifest.expiresAt) <= Date.parse(manifest.issuedAt) ||
    Date.parse(manifest.expiresAt) > Date.parse(manifest.admissionEndsAt)
  )
    throw new Error('Срок снимка недействителен.');
  return manifest;
}
export async function createVaultKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export type SealedCredential = { iv: string; data: string };
export async function sealCredential(
  key: CryptoKey,
  value: string,
  aad: string,
): Promise<SealedCredential> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(value),
  );
  return { iv: encode64(iv), data: encode64(data) };
}
export async function openCredential(key: CryptoKey, sealed: SealedCredential, aad: string) {
  const data = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode64(sealed.iv), additionalData: encoder.encode(aad) },
    key,
    decode64(sealed.data),
  );
  return new TextDecoder().decode(data);
}
export function provisionalEligibility(
  manifest: OfflineManifest,
  credentialHash: string,
  now: number,
) {
  if (now < Date.parse(manifest.issuedAt) || now >= Date.parse(manifest.expiresAt))
    throw new Error('Снимок устарел. Подготовьте мероприятие онлайн.');
  if (now < Date.parse(manifest.admissionStartsAt) || now >= Date.parse(manifest.admissionEndsAt))
    throw new Error('Окно допуска сейчас закрыто.');
  return manifest.hashes.includes(credentialHash);
}
