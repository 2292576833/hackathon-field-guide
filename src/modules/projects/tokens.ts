import { createHash, randomBytes } from "node:crypto";
import { DomainError } from "../../shared/errors.ts";
import type { InvitationTokenPort } from "./ports.ts";

/** Server-only: 256-bit random capability, stored as a SHA-256 digest. */
export function createInvitationTokens(): InvitationTokenPort {
  return {
    issue() {
      const token = randomBytes(32).toString("base64url");
      return { token, tokenHash: createHash("sha256").update(token).digest("hex") };
    },
    hash(token) {
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
        throw new DomainError("INVITATION_UNAVAILABLE", "邀请不存在或已失效，请向管理员索取新链接。", { status: 404 });
      }
      return createHash("sha256").update(token).digest("hex");
    },
  };
}
