import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const nonceLength = 12;
const tagLength = 16;
const algorithm = 'aes-256-gcm';

export class QrCredentials {
  private readonly keys = new Map<string, Buffer>();
  private readonly activeKeyId: string;

  constructor(keyring: string) {
    for (const entry of keyring.split(',')) {
      const [, id, material] = /^([a-z0-9-]{1,32}):([0-9a-f]{64})$/.exec(entry) ?? [];
      if (!id || !material || this.keys.has(id)) throw new Error('Invalid ticket QR keyring');
      this.keys.set(id, Buffer.from(material, 'hex'));
    }
    const active = this.keys.keys().next().value;
    if (!active) throw new Error('Missing ticket QR key');
    this.activeKeyId = active;
  }

  issue(id: string) {
    const credential = randomBytes(24).toString('base64url');
    const nonce = randomBytes(nonceLength);
    const cipher = createCipheriv(algorithm, this.key(this.activeKeyId), nonce);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(credential, 'ascii'), cipher.final()]);
    return {
      qrHash: createHash('sha256').update(credential).digest('hex'),
      qrKeyId: this.activeKeyId,
      qrEncrypted: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]),
    };
  }

  reveal(ticket: { id: string; qrKeyId: string; qrEncrypted: Uint8Array }) {
    const tagEnd = nonceLength + tagLength;
    const decipher = createDecipheriv(
      algorithm,
      this.key(ticket.qrKeyId),
      ticket.qrEncrypted.subarray(0, nonceLength),
    );
    decipher.setAAD(Buffer.from(ticket.id));
    decipher.setAuthTag(ticket.qrEncrypted.subarray(nonceLength, tagEnd));
    return Buffer.concat([
      decipher.update(ticket.qrEncrypted.subarray(tagEnd)),
      decipher.final(),
    ]).toString('ascii');
  }

  private key(id: string) {
    const key = this.keys.get(id);
    if (!key) throw new Error('Ticket QR key unavailable');
    return key;
  }
}
