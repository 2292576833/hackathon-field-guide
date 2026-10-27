import assert from "node:assert/strict";
import test from "node:test";
import { createLoginEmailAdapter } from "./email-adapter.ts";

test("email timeout aborts the provider and rejects acceptance", async () => {
  let signal: AbortSignal | undefined;
  const adapter = createLoginEmailAdapter({
    from: "login@example.com", timeoutMs: 5,
    transport: { async send(_message, options) { signal = options.signal; await new Promise<void>(() => {}); } },
  });
  await assert.rejects(adapter.sendLoginCode({ email: "person@example.com", code: "12345678", expiresAt: "2026-10-08T12:10:00.000Z" }), /timed out/);
  assert.equal(signal?.aborted, true);
});

test("provider rejection is propagated without pretending the email was accepted", async () => {
  const failure = new Error("provider rejected message");
  const adapter = createLoginEmailAdapter({ from: "login@example.com", transport: { async send() { throw failure; } } });
  await assert.rejects(adapter.sendLoginCode({ email: "person@example.com", code: "12345678", expiresAt: "2026-10-08T12:10:00.000Z" }), (error) => error === failure);
});
