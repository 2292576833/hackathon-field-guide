import test from "node:test";
import assert from "node:assert/strict";
import { emailConfiguration } from "./email-config.ts";

test("SMTP selection without an authorization code stays unavailable and ignores old Resend credentials", () => {
  const result = emailConfiguration({ AUTH_EMAIL_PROVIDER: "smtp", SMTP_USER: "sender@qq.com", RESEND_API_KEY: "fixture-obsolete-key" });
  assert.equal(result.smtp, undefined); assert.equal(result.resendKey, undefined); assert.equal(result.emailProvider, "smtp");
});
test("QQ SMTP uses TLS defaults and fixes the sender to the authenticated mailbox", () => {
  const result = emailConfiguration({ AUTH_EMAIL_PROVIDER: "smtp", SMTP_USER: "SENDER@qq.com", SMTP_PASSWORD: "fixture-authorization-code" });
  assert.equal(result.smtp?.host, "smtp.qq.com"); assert.equal(result.smtp?.port, 465); assert.equal(result.smtp?.secure, true);
  assert.equal(result.emailFrom, "黑客松情报局 <sender@qq.com>");
});
test("SMTP refuses header injection, a spoofed sender, URL hosts and unsafe TLS combinations", () => {
  const fixture = { AUTH_EMAIL_PROVIDER: "smtp", SMTP_USER: "sender@qq.com", SMTP_PASSWORD: "fixture-code" };
  for (const overrides of [{ SMTP_USER: "sender@qq.com\r\nBcc: other@example.test" }, { AUTH_EMAIL_FROM: "Other <other@example.test>" },
    { AUTH_EMAIL_FROM: "Sender\r\nBcc: other@example.test <sender@qq.com>" }, { SMTP_HOST: "https://smtp.qq.com" },
    { SMTP_PORT: "25" }, { SMTP_PORT: "465", SMTP_SECURE: "false" }, { SMTP_PORT: "587", SMTP_SECURE: "true" }, { SMTP_SECURE: "yes" }]) {
    assert.throws(() => emailConfiguration({ ...fixture, ...overrides }));
  }
  assert.throws(() => emailConfiguration({ ...fixture, SMTP_USER: "" }));
});
test("port 587 requires STARTTLS while explicit Resend keeps its existing configuration contract", () => {
  assert.equal(emailConfiguration({ AUTH_EMAIL_PROVIDER: "smtp", SMTP_USER: "sender@qq.com", SMTP_PASSWORD: "fixture-code", SMTP_PORT: "587" }).smtp?.secure, false);
  const result = emailConfiguration({ AUTH_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "fixture-key", AUTH_EMAIL_FROM: "login@example.test", SMTP_PASSWORD: "unused-code" });
  assert.equal(result.smtp, undefined); assert.equal(result.resendKey, "fixture-key");
  assert.throws(() => emailConfiguration({ AUTH_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "fixture-key" }));
  assert.throws(() => emailConfiguration({ AUTH_EMAIL_PROVIDER: "invented" }));
});
