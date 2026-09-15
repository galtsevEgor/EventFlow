import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const nonceLength = 12;
const tagEnd = nonceLength + 16;

export class SecretBox {
  private readonly key: Buffer;

  constructor(material: string) {
    if (!/^[a-f0-9]{64}$/.test(material)) throw new Error('Invalid encryption key');
    this.key = Buffer.from(material, 'hex');
  }

  seal(value: string, context: string) {
    const nonce = randomBytes(nonceLength);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  }

  open(value: Uint8Array, context: string) {
    const decipher = createDecipheriv('aes-256-gcm', this.key, value.subarray(0, nonceLength));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(value.subarray(nonceLength, tagEnd));
    return Buffer.concat([decipher.update(value.subarray(tagEnd)), decipher.final()]).toString(
      'utf8',
    );
  }
}
