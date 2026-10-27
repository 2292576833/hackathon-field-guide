import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { createResourceLinkCheckWorker, isPublicResourceCheckIpv4 } from "./link-check-worker.ts";
import type { ResourceLinkResponse, ResourceLinkTransport } from "./link-check-worker.ts";

const approved = "https://lucide.dev/";
const now = "2026-10-08T14:30:00.000Z";
function fixture(responses: readonly ResourceLinkResponse[], urls = [approved]) {
  const called: string[] = [];
  const transport: ResourceLinkTransport = {async head(url) { called.push(url); return responses[Math.min(called.length - 1, responses.length - 1)]; }};
  return {called, worker: createResourceLinkCheckWorker({approvedUrls: urls, clock: {now: () => new Date(now)}, transport})};
}
test("未审批完整 URL 和不支持协议/端口不会执行 HTTP", async () => {
  const f = fixture([{statusCode: 200, location: null}]);
  for (const value of ["https://lucide.dev/other", "https://evil.example/", "http://lucide.dev/", "https://lucide.dev:8443/", "https://127.0.0.1/", "https://user:password@lucide.dev/"]) {
    await assert.rejects(f.worker.check(value), (error: unknown) => error instanceof DomainError);
  }
  assert.equal(f.called.length, 0);
});
test("仅成功 HEAD 报可访问；不存在与账号受限/HEAD不支持分开", async () => {
  for (const [statusCode, expected] of [[200, "available"], [204, "available"], [404, "unreachable"], [410, "unreachable"], [401, "unknown"], [403, "unknown"], [405, "unknown"], [429, "unknown"], [500, "unknown"]] as const) {
    const f = fixture([{statusCode, location: null}]);
    const result = await f.worker.check(approved);
    assert.equal(result.status, expected);
    assert.equal(result.httpStatus, statusCode);
    assert.equal(result.checkedAt, now);
  }
});
test("跳转只能进入已审批精确 URL，未知/私网跳转被阻断", async () => {
  for (const location of ["https://evil.example/", "https://127.0.0.1/", "/not-approved", "javascript:alert(1)"]) {
    const f = fixture([{statusCode: 302, location}]);
    const result = await f.worker.check(approved);
    assert.equal(result.reason, "redirect_not_approved");
    assert.deepEqual(f.called, [approved]);
  }
  const destination = "https://lucide.dev/icons/";
  const f = fixture([{statusCode: 302, location: "/icons/"}, {statusCode: 200, location: null}], [approved, destination]);
  assert.equal((await f.worker.check(approved)).finalUrl, destination);
  assert.deepEqual(f.called, [approved, destination]);
});
test("跳转循环有界，挂起的 HTTP 受总超时控制", async () => {
  const cycle = fixture([{statusCode: 302, location: approved}]);
  assert.equal((await cycle.worker.check(approved)).reason, "redirect_limit");
  assert.equal(cycle.called.length, 4);
  let signal: AbortSignal | undefined;
  const worker = createResourceLinkCheckWorker({approvedUrls: [approved], clock: {now: () => new Date(now)}, timeoutMs: 10,
    transport: {head(_url, currentSignal) { signal = currentSignal; return new Promise(() => {}); }}});
  assert.equal((await worker.check(approved)).reason, "request_timeout");
  assert.equal(signal?.aborted, true);
});
test("公网 DNS 守卫拒绝私网、回环、链路本地、文档保留和 IPv6", () => {
  for (const value of ["0.0.0.0", "10.2.3.4", "127.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(isPublicResourceCheckIpv4(value), false, value);
  assert.equal(isPublicResourceCheckIpv4("1.1.1.1"), true);
  assert.equal(isPublicResourceCheckIpv4("8.8.8.8"), true);
});
test("网络/地址错误只输出稳定原因，不把链接检查当内容发布", async () => {
  const worker = createResourceLinkCheckWorker({approvedUrls: [approved], clock: {now: () => new Date(now)}, transport: {async head() { throw new DomainError("RESOURCE_NETWORK_ADDRESS_BLOCKED", "private detail"); }}});
  const result = await worker.check(approved);
  assert.equal(result.reason, "network_address_blocked");
  assert.equal(result.status, "unknown");
  assert.equal(JSON.stringify(result).includes("private detail"), false);
  assert.equal("publicationStatus" in result, false);
});
