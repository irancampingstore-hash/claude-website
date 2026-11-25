import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Derive purpose-specific 32-byte keys from the master HUB_SECRET. */
export function deriveKey(master: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(master, "utf8"), Buffer.alloc(0), Buffer.from(`iran-camping-hub:${purpose}`), 32));
}

export function encrypt(master: string, plaintext: string): string {
  const key = deriveKey(master, "storage");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}

export function decrypt(master: string, payload: string): string {
  const [v, iv, tag, data] = payload.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("bad ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(master, "storage"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

export function hmac(master: string, purpose: string, data: string): string {
  return createHmac("sha256", deriveKey(master, purpose)).update(data).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, 32);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const calc = scryptSync(secret, Buffer.from(salt, "base64url"), 32);
  const expected = Buffer.from(hash, "base64url");
  return calc.length === expected.length && timingSafeEqual(calc, expected);
}

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}
