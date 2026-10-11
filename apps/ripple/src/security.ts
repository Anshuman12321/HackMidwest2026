import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { RippleError } from './types.ts';
export class Secrets {
  key: Buffer;
  constructor(secret: string) {
    if (secret.length < 32) throw new Error('RIPPLE_SECRET must contain at least 32 characters.');
    this.key = createHash('sha256').update(secret).digest();
  }
  sign(value: unknown, purpose: string): string {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return body + '.' + createHmac('sha256', this.key).update(purpose + ':' + body).digest('base64url');
  }
  verify<T>(token: string, purpose: string): T {
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra) throw new RippleError('permission_denied', 'Invalid signed state.');
    const expected = createHmac('sha256', this.key).update(purpose + ':' + body).digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new RippleError('permission_denied', 'Invalid signed state.');
    try { return JSON.parse(Buffer.from(body, 'base64url').toString()); }
    catch { throw new RippleError('invalid_request', 'Invalid signed state.'); }
  }
  encrypt(token: string): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const value = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), value]).toString('base64url');
  }
  decrypt(value: string): string {
    const bytes = Buffer.from(value, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
  }
}
