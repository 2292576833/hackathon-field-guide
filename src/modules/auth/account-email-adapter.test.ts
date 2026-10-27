import assert from "node:assert/strict";
import test from "node:test";
import { createAccountEmailAdapter } from "./account-email-adapter.ts";
import type { TransactionalEmailTransportPort } from "./email-adapter.ts";

const challenge = { email: "owner@example.com", code: "12345678", expiresAt: "2026-10-10T12:10:00.000Z" };

test("mailbox change uses distinct current and new email proof templates", async () => {
  const messages: Parameters<TransactionalEmailTransportPort["send"]>[0][] = [];
  const adapter = createAccountEmailAdapter({ from: "accounts@example.com", transport: {
    async send(message, { signal }) { assert.equal(signal.aborted, false); messages.push(message); },
  } });
  await adapter.sendEmailChangeCode({ ...challenge, purpose: "current_email" });
  await adapter.sendEmailChangeCode({ ...challenge, email: "next@example.com", purpose: "new_email" });
  assert.equal(messages[0]?.to, "owner@example.com");
  assert.equal(messages[1]?.to, "next@example.com");
  assert.match(messages[0]!.subject, /确认更换登录邮箱/);
  assert.match(messages[1]!.subject, /验证新的登录邮箱/);
  assert.match(messages[0]!.text, /当前邮箱的确认验证码/);
  assert.match(messages[1]!.text, /新邮箱的验证码/);
  assert.match(messages[0]!.text, /所有旧登录会话退出/);
  assert.match(messages[1]!.text, /同一个账号/);
});

test("mailbox change only resolves after provider acknowledgement", async () => {
  let accept: (() => void) | undefined;
  let completed = false;
  const adapter = createAccountEmailAdapter({ from: "accounts@example.com", transport: {
    async send() { await new Promise<void>((resolve) => { accept = resolve; }); },
  } });
  const pending = adapter.sendEmailChangeCode({ ...challenge, purpose: "new_email" }).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  accept!();
  await pending;
  assert.equal(completed, true);
});

test("unknown provider outcome is rejected without retrying the send", async () => {
  const unknown = new Error("provider acceptance unknown");
  let sends = 0;
  const adapter = createAccountEmailAdapter({ from: "accounts@example.com", transport: {
    async send() { sends++; throw unknown; },
  } });
  await assert.rejects(adapter.sendEmailChangeCode({ ...challenge, purpose: "current_email" }), (error) => error === unknown);
  assert.equal(sends, 1);
});

test("timeout aborts a mailbox change send and never reports success", async () => {
  let signal: AbortSignal | undefined;
  let sends = 0;
  const adapter = createAccountEmailAdapter({ from: "accounts@example.com", timeoutMs: 5, transport: {
    async send(_message, options) { sends++; signal = options.signal; await new Promise<void>(() => {}); },
  } });
  await assert.rejects(adapter.sendEmailChangeCode({ ...challenge, purpose: "new_email" }), /timed out/);
  assert.equal(signal?.aborted, true);
  assert.equal(sends, 1);
});

test("adapter rejects invalid sender, timing and challenge input before delivery", async () => {
  let sends = 0;
  const transport: TransactionalEmailTransportPort = { async send() { sends++; } };
  assert.throws(() => createAccountEmailAdapter({ from: "accounts@example.com\r\nBcc: other@example.com", transport }));
  assert.throws(() => createAccountEmailAdapter({ from: "accounts@example.com", timeoutMs: 0, transport }));
  const adapter = createAccountEmailAdapter({ from: "accounts@example.com", transport });
  await assert.rejects(adapter.sendEmailChangeCode({ ...challenge, email: "person@example.com\nother@example.com", purpose: "new_email" }));
  await assert.rejects(adapter.sendEmailChangeCode({ ...challenge, code: "1234567", purpose: "new_email" }));
  await assert.rejects(adapter.sendEmailChangeCode({ ...challenge, expiresAt: "unknown", purpose: "new_email" }));
  assert.equal(sends, 0);
});
