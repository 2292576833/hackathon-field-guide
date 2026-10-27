import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import type { GuanchaCryptoPort } from "./ports.ts";
import type { GuanchaAttemptSecrets } from "./types.ts";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
function validSecrets(value: unknown): value is GuanchaAttemptSecrets {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 2
    && (item.codeVerifier === null || typeof item.codeVerifier === "string" && tokenPattern.test(item.codeVerifier))
    && (item.nonce === null || typeof item.nonce === "string" && tokenPattern.test(item.nonce));
}

/** No environment access: coordinator injects a stable server-only secret. */
export function createNodeGuanchaCrypto(secret: string): GuanchaCryptoPort {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) throw new Error("Guancha state encryption requires a server secret of at least 32 bytes.");
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.from("guancha-login-v1"), Buffer.from("attempt-secrets"), 32));
  return {
    randomToken: () => randomBytes(32).toString("base64url"),
    hash: (value) => createHash("sha256").update(value, "utf8").digest("hex"),
    s256: (value) => createHash("sha256").update(value, "ascii").digest("base64url"),
    seal(value, stateHash) {
      if (!validSecrets(value) || !/^[a-f0-9]{64}$/.test(stateHash)) throw new Error("Invalid Guancha attempt secrets.");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(`guancha-login-v1:${stateHash}`));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      return `v1.${iv.toString("base64url")}.${encrypted.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
    },
    open(ciphertext, stateHash) {
      try {
        if (typeof ciphertext !== "string" || ciphertext.length > 1024 || !/^[a-f0-9]{64}$/.test(stateHash)) throw new Error();
        const parts = ciphertext.split(".");
        if (parts.length !== 4 || parts[0] !== "v1" || !parts.slice(1).every(value => /^[A-Za-z0-9_-]+$/.test(value))) throw new Error();
        const iv = Buffer.from(parts[1]!, "base64url"), encrypted = Buffer.from(parts[2]!, "base64url"), tag = Buffer.from(parts[3]!, "base64url");
        if (iv.length !== 12 || tag.length !== 16) throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.from(`guancha-login-v1:${stateHash}`));
        decipher.setAuthTag(tag);
        const value: unknown = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"));
        if (!validSecrets(value)) throw new Error();
        return value;
      } catch {
        throw new Error("Guancha attempt secrets could not be verified.");
      }
    },
  };
}
