import test from "node:test";
import assert from "node:assert/strict";
import { SENDER_PROVIDERS, prepareSenderAccountInput, safeSenderMetadata, senderSaveFailureText, validateSenderDraft, type SenderProvider } from "./model.ts";

test("固定SMTP提供商仅QQ/163/126/Gmail，邮箱验证不冒充已认证", () => {
  assert.deepEqual(SENDER_PROVIDERS, ["qq", "163", "126", "gmail"]);
  assert.deepEqual(validateSenderDraft({ provider: "qq", email: "manager@qq.com" }, "controlled-code"), []);
  assert.deepEqual(validateSenderDraft({ provider: "qq", email: "manager@foxmail.com" }, "controlled-code"), []);
  assert.deepEqual(validateSenderDraft({ provider: "163", email: "manager@163.com" }, "controlled-code"), []);
  assert.deepEqual(validateSenderDraft({ provider: "126", email: "manager@126.com" }, "controlled-code"), []);
  assert.deepEqual(validateSenderDraft({ provider: "gmail", email: "manager@gmail.com" }, "controlled-code"), []);
  assert.deepEqual(validateSenderDraft({ provider: "gmail", email: "manager@mycompany.example" }, "controlled-code"), []);
  assert.ok(validateSenderDraft({ provider: "outlook" as SenderProvider, email: "manager@outlook.com" }, "controlled-code").length);
});
test("邮件格式与控制字符拒绝，不把secret带入错误文本", () => {
  for (const email of ["", "manager", "a@b", "a@qq.com\r\nBcc:x", "<manager@qq.com>"]) assert.ok(validateSenderDraft({ provider: "qq", email }, "controlled-secret").length);
  assert.ok(validateSenderDraft({ provider: "qq", email: "manager@qq.com" }, "").length);
  assert.ok(validateSenderDraft({ provider: "qq", email: "manager@qq.com" }, "controlled-secret\r\n").length);
  assert.ok(validateSenderDraft({ provider: "qq", email: "manager@qq.com" }, "x".repeat(4097)).length);
  assert.ok(validateSenderDraft({ provider: "qq", email: "manager@qq.com" }, "controlled-secret\u0000").every(error => !error.includes("controlled-secret")));
});
const metadata = { organizationId: "org-a", revision: 3, state: "verified", provider: "qq", maskedEmail: "m***@qq.com", verifiedAt: "2026-10-11T06:00:00Z", updatedAt: "2026-10-11T06:00:00Z", profiles: [{ id: "qq", label: "QQ 邮箱", note: "授权码" }] };
test("safe metadata只取安全字段，不保存响应中额外密码或密文", () => {
  const safe = safeSenderMetadata({ ...metadata, authorizationCode: "controlled-secret", credential: "controlled-ciphertext", email: "manager@qq.com" }, "org-a");
  assert.deepEqual(safe, metadata); assert.ok(!JSON.stringify(safe).includes("controlled-secret")); assert.ok(!JSON.stringify(safe).includes("controlled-ciphertext")); assert.ok(!("email" in safe));
});
test("safe metadata拒绝跨机构/不合法版本/未支持provider", () => {
  assert.throws(() => safeSenderMetadata(metadata, "org-b"));
  assert.throws(() => safeSenderMetadata({ ...metadata, revision: -1 }, "org-a"));
  assert.throws(() => safeSenderMetadata({ ...metadata, provider: "outlook" }, "org-a"));
  assert.throws(() => safeSenderMetadata({ ...metadata, profiles: [{ id: "outlook", label: "x", note: "x" }] }, "org-a"));
});
test("CAS保存参数只能来自用户完整地址，不将metadata mask回填", () => {
  const safe = safeSenderMetadata(metadata, "org-a");
  const input = prepareSenderAccountInput(safe.revision, { provider: "qq", email: " manager@qq.com " }, "controlled-code");
  assert.deepEqual(input, { expectedRevision: 3, provider: "qq", email: "manager@qq.com", authorizationCode: "controlled-code" });
  assert.throws(() => prepareSenderAccountInput(-1, { provider: "qq", email: "manager@qq.com" }, "controlled-code"));
});
test("认证失败503与网络未知分开，用户错误文本不读取raw message", () => {
  assert.match(senderSaveFailureText({ status: 503, code: "ORGANIZER_MAIL_VERIFICATION_FAILED" }), /未保存，原有设置保留/);
  assert.match(senderSaveFailureText({ status: 503, code: "UNAVAILABLE" }), /结果尚未确认/);
  assert.match(senderSaveFailureText(), /不会自动重试/);
  assert.match(senderSaveFailureText({ status: 409, code: "ORGANIZER_MAIL_REVISION_CONFLICT" }), /已被更新/);
  assert.match(senderSaveFailureText({ status: 429, code: "ORGANIZER_MAIL_VERIFICATION_RATE_LIMIT" }), /60 秒/);
});
