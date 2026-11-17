/** Small crypto helpers on WebCrypto / Bun built-ins. */
import { timingSafeEqual } from "node:crypto";

const enc = new TextEncoder();

export function randomToken(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

export function sha256(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

export function sha256Bytes(b: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(b).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** AES-256-GCM with a key derived from APP_SECRET. Output: base64(iv ‖ ciphertext+tag). */
export class Sealer {
  private key: Promise<CryptoKey>;

  constructor(secret: string) {
    this.key = crypto.subtle
      .digest("SHA-256", enc.encode(`pf-fleet:${secret}`))
      .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  }

  async seal(plain: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.key, enc.encode(plain)));
    return Buffer.concat([iv, ct]).toString("base64");
  }

  async open(sealed: string): Promise<string> {
    const buf = Buffer.from(sealed, "base64");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.subarray(0, 12) }, await this.key, buf.subarray(12));
    return new TextDecoder().decode(plain);
  }
}
