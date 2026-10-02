import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";

/**
 * Field-level encryption for sensitive data at rest (raw evidence, model
 * inputs and outputs, OAuth tokens, transcripts, artifacts, audio).
 * AES-256-GCM with a random 96-bit IV per value.
 */
export class Cipher {
  private key: Buffer;

  constructor(hexKey: string) {
    const key = Buffer.from(hexKey, "hex");
    if (key.length !== 32) throw new Error("AVA_ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
    this.key = key;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    const tag = c.getAuthTag();
    return `v1:${Buffer.concat([iv, tag, ct]).toString("base64")}`;
  }

  decrypt(stored: string): string {
    if (!stored.startsWith("v1:")) throw new Error("Unknown ciphertext format");
    const buf = Buffer.from(stored.slice(3), "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const d = createDecipheriv("aes-256-gcm", this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  }

  encryptBuffer(plain: Buffer): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([Buffer.from("AVA1"), iv, c.getAuthTag(), ct]);
  }

  decryptBuffer(stored: Buffer): Buffer {
    if (stored.subarray(0, 4).toString() !== "AVA1") throw new Error("Unknown encrypted file format");
    const iv = stored.subarray(4, 16);
    const tag = stored.subarray(16, 32);
    const d = createDecipheriv("aes-256-gcm", this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(stored.subarray(32)), d.final()]);
  }

  encJson(v: unknown): string {
    return this.encrypt(JSON.stringify(v ?? null));
  }

  decJson<T>(stored: string | null | undefined, fallback: T): T {
    if (!stored) return fallback;
    try {
      return JSON.parse(this.decrypt(stored)) as T;
    } catch {
      return fallback;
    }
  }

  decOpt(stored: string | null | undefined): string | null {
    if (!stored) return null;
    try {
      return this.decrypt(stored);
    } catch {
      return null;
    }
  }

  hmac(value: string): string {
    return createHmac("sha256", this.key).update(value).digest("hex");
  }
}

/** scrypt$N$r$p$salt$hash */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const hash = scryptSync(password, salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
