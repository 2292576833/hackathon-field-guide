import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import type { AuthCryptoPort } from "./ports.ts";

/** HMAC protects low-entropy email codes when the database alone is exposed. */
export function createNodeAuthCrypto(pepper: string): AuthCryptoPort {
  if (Buffer.byteLength(pepper, "utf8") < 32) {
    throw new Error("AUTH_CODE_PEPPER must contain at least 32 bytes of secret material.");
  }
  const digest = (purpose: string, ...values: string[]) =>
    createHmac("sha256", pepper).update(JSON.stringify([purpose, ...values])).digest("hex");
  return {
    generateCode: () => randomInt(0, 100_000_000).toString().padStart(8, "0"),
    generateSessionToken: () => randomBytes(32).toString("base64url"),
    hashCode: (id, code) => digest("login-code-v1", id, code),
    hashSessionToken: (token) => createHash("sha256").update(token).digest("hex"),
    hashRateKey: (purpose, value) => digest("rate-key-v1", purpose, value),
  };
}
