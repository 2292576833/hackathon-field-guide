import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { types as utilTypes } from "node:util";
import { DomainError } from "../../shared/errors.ts";
import type { CredentialCipher, EncryptedValue } from "./authorization-types.ts";

const PAYLOAD_BYTES = 65_536;
const AAD_VERSION = "m06.github.aes256gcm.v1";
const KEY_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export interface CredentialCipherOptions { activeKeyId: string; keyring: Record<string, string> }

function configError(): DomainError {
  return new DomainError("CREDENTIAL_CIPHER_CONFIG_INVALID", "服务端凭据加密配置无效。", { status: 500 });
}
function inputError(): DomainError {
  return new DomainError("CREDENTIAL_CIPHER_INPUT_INVALID", "授权凭据必须是有限大小的有效 JSON 数据。", { status: 422 });
}
function cipherError(): DomainError {
  return new DomainError("CREDENTIAL_CIPHER_FAILED", "授权凭据无法安全读取，请重新连接 GitHub。", { status: 503, recoveryAction: "reauthorize_github" });
}
function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function base64(value: unknown, minBytes: number, maxBytes: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes / 3) * 4 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw inputError();
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < minBytes || decoded.length > maxBytes || decoded.toString("base64") !== value) throw inputError();
  return decoded;
}
function assertContext(context: unknown): asserts context is string {
  if (typeof context !== "string" || context.length === 0 || Buffer.byteLength(context, "utf8") > 1_024 || CONTROLS.test(context) || !wellFormed(context)) throw inputError();
}

/** Serialize a JSON clone without invoking getters, toJSON, or custom prototypes. */
function serializeJson(value: unknown): string {
  const chunks: string[] = [];
  const stack = new Set<object>();
  let bytes = 0;
  function append(chunk: string): void {
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > PAYLOAD_BYTES) throw inputError();
    chunks.push(chunk);
  }
  function visit(item: unknown, depth: number): void {
    if (depth > 64) throw inputError();
    if (item === null) { append("null"); return; }
    if (typeof item === "string") {
      if (!wellFormed(item) || Buffer.byteLength(item, "utf8") > PAYLOAD_BYTES) throw inputError();
      append(JSON.stringify(item)); return;
    }
    if (typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) { append(JSON.stringify(item)); return; }
    if (typeof item !== "object" || stack.has(item) || utilTypes.isProxy(item)) throw inputError();
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(item).length !== 0) throw inputError();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.values(descriptors).some(descriptor => !Object.prototype.hasOwnProperty.call(descriptor, "value"))) throw inputError();
    stack.add(item);
    if (Array.isArray(item)) {
      if (item.length > PAYLOAD_BYTES || Object.keys(item).some(key => !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length)) throw inputError();
      append("[");
      for (let index = 0; index < item.length; index += 1) {
        if (index > 0) append(",");
        if (!Object.prototype.hasOwnProperty.call(descriptors, String(index))) throw inputError();
        visit(descriptors[String(index)].value, depth + 1);
      }
      append("]");
    } else {
      append("{");
      let count = 0;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) throw inputError();
        if (!wellFormed(key) || Buffer.byteLength(key, "utf8") > PAYLOAD_BYTES) throw inputError();
        if (count++ > 0) append(",");
        append(JSON.stringify(key)); append(":"); visit(descriptor.value, depth + 1);
      }
      append("}");
    }
    stack.delete(item);
  }
  visit(value, 0);
  return chunks.join("");
}

/** Server-only keyring. Keep old keys until all persisted envelopes have been rotated. */
export class AesGcmCredentialCipher implements CredentialCipher {
  readonly #activeKeyId: string;
  readonly #keys: Map<string, Buffer>;
  constructor(options: CredentialCipherOptions) {
    try {
      if (!options || typeof options.activeKeyId !== "string" || !KEY_ID.test(options.activeKeyId) || !options.keyring || typeof options.keyring !== "object" || Array.isArray(options.keyring)) throw configError();
      const descriptors = Object.getOwnPropertyDescriptors(options.keyring);
      if (Object.keys(descriptors).length === 0 || Object.keys(descriptors).length > 32 || Object.getOwnPropertySymbols(options.keyring).length > 0) throw configError();
      const keys = new Map<string, Buffer>();
      for (const [keyId, descriptor] of Object.entries(descriptors)) {
        if (!KEY_ID.test(keyId) || !Object.prototype.hasOwnProperty.call(descriptor, "value")) throw configError();
        keys.set(keyId, base64(descriptor.value, 32, 32));
      }
      if (!keys.has(options.activeKeyId)) throw configError();
      this.#activeKeyId = options.activeKeyId;
      this.#keys = keys;
    } catch { throw configError(); }
  }

  encrypt(value: unknown, context: string): EncryptedValue {
    assertContext(context);
    const json = serializeJson(value);
    const plain = Buffer.from(json, "utf8");
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.#keys.get(this.#activeKeyId)!, iv, { authTagLength: 16 });
      cipher.setAAD(Buffer.from(JSON.stringify([AAD_VERSION, this.#activeKeyId, context]), "utf8"));
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      return { keyId: this.#activeKeyId, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") };
    } catch { throw cipherError(); }
    finally { plain.fill(0); }
  }

  decrypt<T>(value: EncryptedValue, context: string): T {
    let plain: Buffer | undefined;
    try {
      assertContext(context);
      if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) throw cipherError();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.keys(descriptors).sort().join(",") !== "data,iv,keyId,tag" || Object.values(descriptors).some(descriptor => !Object.prototype.hasOwnProperty.call(descriptor, "value")) || Object.getOwnPropertySymbols(value).length > 0) throw cipherError();
      const keyId: unknown = descriptors.keyId.value;
      if (typeof keyId !== "string" || !KEY_ID.test(keyId) || !this.#keys.has(keyId)) throw cipherError();
      const iv = base64(descriptors.iv.value, 12, 12);
      const tag = base64(descriptors.tag.value, 16, 16);
      const data = base64(descriptors.data.value, 1, PAYLOAD_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", this.#keys.get(keyId)!, iv, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(JSON.stringify([AAD_VERSION, keyId, context]), "utf8"));
      decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(data), decipher.final()]);
      if (plain.length > PAYLOAD_BYTES) throw cipherError();
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(plain);
      const parsed: unknown = JSON.parse(decoded);
      // Re-validate the decoded structure and budget before returning an independent JSON value.
      serializeJson(parsed);
      return parsed as T;
    } catch { throw cipherError(); }
    finally { plain?.fill(0); }
  }
}
