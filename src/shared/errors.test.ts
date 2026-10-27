import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, isDomainError, toErrorEnvelope } from "./errors.ts";

test("error envelopes recognize DomainError instances from another production bundle", () => {
  const foreign = Object.assign(new Error("来源不匹配。"), {
    name: "DomainError",
    code: "ORIGIN_FORBIDDEN",
    status: 403,
  });
  assert.equal(isDomainError(foreign), true);
  assert.deepEqual(toErrorEnvelope(foreign, "request-1"), {
    error: { code: "ORIGIN_FORBIDDEN", message: "来源不匹配。" }, requestId: "request-1",
  });
});

test("error envelopes do not trust arbitrary status-bearing errors", () => {
  const foreign = Object.assign(new Error("provider failure"), { status: 403, code: "ORIGIN_FORBIDDEN" });
  assert.equal(isDomainError(foreign), false);
  assert.deepEqual(toErrorEnvelope(foreign, "request-2"), {
    error: { code: "INTERNAL_ERROR", message: "服务暂时无法完成操作，请稍后重试。" }, requestId: "request-2",
  });
  assert.equal(isDomainError(new DomainError("INVALID", "invalid")), true);
});
