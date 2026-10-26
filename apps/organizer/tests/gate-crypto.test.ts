import { describe, it, expect } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  hash,
  importPublicKey,
  verifyManifest,
  sealCredential,
  openCredential,
  createVaultKey,
  provisionalEligibility,
} from '../src/gate/crypto';
const context = {
  actorSubject: 'operator',
  organizationId: crypto.randomUUID(),
  eventId: crypto.randomUUID(),
  deviceId: crypto.randomUUID(),
};
function bundle() {
  const keys = generateKeyPairSync('ed25519'),
    jwk = keys.publicKey.export({ format: 'jwk' }),
    id = createHash('sha256').update(Buffer.from(jwk.x!, 'base64url')).digest('hex');
  const manifest = {
    version: 1,
    sessionId: crypto.randomUUID(),
    ...context,
    issuedAt: '2026-11-10T10:00:00.000Z',
    expiresAt: '2026-11-10T10:30:00.000Z',
    admissionStartsAt: '2026-11-10T09:00:00.000Z',
    admissionEndsAt: '2026-11-10T12:00:00.000Z',
    hashes: ['a'.repeat(64)],
  };
  const payload = JSON.stringify(manifest);
  return {
    manifest,
    input: {
      payload,
      signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64url'),
      keyId: id,
    },
    publicKey: { id, jwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x! } },
  };
}
describe('offline snapshot trust and credential vault', () => {
  it('verifies the original signed bytes and rejects tampering, wrong key and another account', async () => {
    const data = bundle(),
      key = await importPublicKey(data.publicKey);
    expect(await verifyManifest(data.input, key.id, key.key, context)).toEqual(data.manifest);
    await expect(
      verifyManifest(
        { ...data.input, payload: data.input.payload.replace('10:30', '11:30') },
        key.id,
        key.key,
        context,
      ),
    ).rejects.toThrow('Подпись');
    await expect(
      verifyManifest(data.input, key.id, key.key, { ...context, actorSubject: 'another' }),
    ).rejects.toThrow('другому');
    await expect(importPublicKey({ ...data.publicKey, id: 'b'.repeat(64) })).rejects.toThrow(
      'Ключ',
    );
  });
  it('encrypts QR credentials with non-exportable keys and operation-scoped authentication', async () => {
    const key = await createVaultKey(),
      credential = 'z'.repeat(32),
      sealed = await sealCredential(key, credential, 'session:operation');
    expect(key.extractable).toBe(false);
    expect(JSON.stringify(sealed)).not.toContain(credential);
    expect(await openCredential(key, sealed, 'session:operation')).toBe(credential);
    await expect(openCredential(key, sealed, 'other:operation')).rejects.toThrow();
  });
  it('enforces exact expiry and admission boundaries without treating unknown codes as tickets', async () => {
    const { manifest } = bundle();
    expect(provisionalEligibility(manifest, 'a'.repeat(64), Date.parse(manifest.issuedAt))).toBe(
      true,
    );
    expect(provisionalEligibility(manifest, 'b'.repeat(64), Date.parse(manifest.issuedAt))).toBe(
      false,
    );
    expect(() =>
      provisionalEligibility(manifest, 'a'.repeat(64), Date.parse(manifest.expiresAt)),
    ).toThrow('устарел');
    expect(await hash('z'.repeat(32))).toBe(
      createHash('sha256').update('z'.repeat(32)).digest('hex'),
    );
  });
});
