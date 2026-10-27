import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { compressPublicResponse } from "./public-response-compression.ts";

const data = { data: { items: Array.from({ length: 30 }, (_, id) => ({ id, title: "真实已保存赛事分析", summary: "需要阅读报名条件和主办方说明。".repeat(20) })) } };
function request(path = "/event-discoveries?limit=60", encoding = "gzip, deflate, br", method = "GET") { return new Request(`https://example.test/api/v1${path}`, { method, headers: { "accept-encoding": encoding } }); }
function response() { return Response.json(data, { headers: { "cache-control": "private, no-store", vary: "RSC" } }); }
test("public saved results compress losslessly and retain no-store", async () => {
  const result = await compressPublicResponse(request(), response());
  assert.equal(result.headers.get("content-encoding"), "gzip");
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.match(result.headers.get("vary")!, /RSC, Accept-Encoding/);
  const bytes = Buffer.from(await result.arrayBuffer());
  assert.deepEqual(JSON.parse(gunzipSync(bytes).toString()), data);
  assert.ok(bytes.length < JSON.stringify(data).length / 4);
  assert.equal(result.headers.get("content-length"), String(bytes.length));
});
test("explicit gzip opt-out wins over wildcard; identity and unsupported encodings remain readable", async () => {
  for (const encoding of ["gzip;q=0, *;q=1", "br", "identity", "", "gzip;q=NaN", "gzip;q=2"]) {
    const result = await compressPublicResponse(request(undefined, encoding), response());
    assert.equal(result.headers.get("content-encoding"), null);
    assert.deepEqual(await result.json(), data);
  }
  assert.equal((await compressPublicResponse(request(undefined, "*;q=0.5"), response())).headers.get("content-encoding"), "gzip");
});
test("private data, writes, errors, cookies and encoded responses bypass compression", async () => {
  for (const path of ["/me", "/projects/p1", "/navigator/conversation", "/organizer/events/e1", "/auth/guancha/status"]) {
    assert.equal((await compressPublicResponse(request(path), response())).headers.get("content-encoding"), null);
  }
  for (const method of ["POST", "HEAD"]) assert.equal((await compressPublicResponse(request(undefined, undefined, method), response())).headers.get("content-encoding"), null);
  const failure = Response.json(data, { status: 403 });
  assert.equal(await compressPublicResponse(request(), failure), failure);
  for (const headers of [{ "set-cookie": "fixture=private" }, { "content-encoding": "br" }] as Record<string, string>[]) {
    const original = Response.json(data, { headers });
    assert.equal(await compressPublicResponse(request(), original), original);
  }
});
test("small response and oversized response preserve their body without encoding", async () => {
  for (const value of [{ data: "ok" }, { data: "x".repeat(2 * 1024 * 1024) }]) {
    const result = await compressPublicResponse(request(), Response.json(value));
    assert.equal(result.headers.get("content-encoding"), null);
    assert.deepEqual(await result.json(), value);
  }
});
