import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../../shared/contracts.ts";
import { DomainError } from "../../../shared/errors.ts";
import { createRetrospectiveEditDraftHandlers } from "../edit-drafts-handlers.ts";
import { validateEditDraftSaveInput } from "../edit-drafts.ts";
import type { RetrospectiveEditDraftService } from "../edit-drafts.ts";

const actor: Actor = { userId: "session-owner", platformRoles: ["user"] };
const input = { documentId: null, baseDocumentRevision: 0, expectedRevision: 0, mutationId: "save-1", requestedScope: "project", draftContent: { answers: { goalAndOutcome: "", blockerAndResponse: "", helpfulPractice: "", scopeReduction: "", nextChange: "  保留输入  " }, evidenceRefs: [], tools: [] } };
function fixture() {
  const calls: { name: string; args: unknown[] }[] = [];
  let authenticated = true, failure: Error | undefined;
  const method = (name: string, output: unknown) => async (...args: unknown[]) => { calls.push({ name, args }); if (failure) throw failure; if (name === "save") validateEditDraftSaveInput(args[2]); return output; };
  const service = { get: method("get", null), getById: method("getById", { id: "draft-1", visibility: "personal" }), save: method("save", { draft: { revision: 1, visibility: "personal" }, acceptedRevision: 1, replayed: false }), list: method("list", { items: [], nextCursor: null }), delete: method("delete", undefined), exportDraft: method("exportDraft", { content: "本人草稿", mediaType: "text/markdown; charset=utf-8", filename: "retrospective-edit-draft-1.md" }) } as unknown as RetrospectiveEditDraftService;
  return { calls, handlers: createRetrospectiveEditDraftHandlers({ service, authenticate: async () => authenticated ? actor : null, requestId: () => "request-1" }), unauthenticate() { authenticated = false; }, fail(error: Error) { failure = error; } };
}
function request(method = "PUT", value: unknown = input, url = "https://field.test/api/v1/projects/p1/retrospective-edit-draft"): Request {
  return new Request(url, { method, ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(value) }) });
}

test("draft handlers use session identity and return missing editor buffer as null", async () => {
  const f = fixture(), response = await f.handlers.get(request("GET"), { projectId: "p1" });
  assert.equal(response.status, 200); assert.equal((await response.json()).data, null);
  assert.deepEqual(f.calls, [{ name: "get", args: [actor, "p1", null] }]);
  assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("vary"), "cookie");
  const saved = await f.handlers.save(request(), { projectId: "p1" });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).data.acceptedRevision, 1);
  assert.deepEqual(f.calls.at(-1)?.args, [actor, "p1", input]);
});

test("unauthenticated and wrong method requests cannot reach draft service", async () => {
  const f = fixture(); f.unauthenticate();
  const response = await f.handlers.save(request(), { projectId: "p1" }); assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "UNAUTHENTICATED"); assert.deepEqual(f.calls, []);
  const wrong = await f.handlers.save(request("POST"), { projectId: "p1" }); assert.equal(wrong.status, 405); assert.equal(wrong.headers.get("allow"), "PUT");
});

test("body and query whitelists reject identity impersonation and mismatched editor objects", async () => {
  const f = fixture();
  for (const value of [{ ...input, ownerId: "victim" }, { ...input, userId: "victim" }, { ...input, publish: true }]) {
    const response = await f.handlers.save(request("PUT", value), { projectId: "p1" }); assert.equal(response.status, 422);
  }
  const mismatch = await f.handlers.save(request("PUT", input, "https://field.test/edit?documentId=other"), { projectId: "p1" }); assert.equal(mismatch.status, 422);
  for (const query of ["ownerId=victim", "documentId=a&documentId=b", "documentId="]) {
    const response = await f.handlers.get(request("GET", undefined, `https://field.test/edit?${query}`), { projectId: "p1" }); assert.equal(response.status, 422);
  }
  assert.deepEqual(f.calls, []);
});

test("body byte limit is enforced on declared and undeclared streamed JSON", async () => {
  const f = fixture();
  const declared = new Request("https://field.test/edit", { method: "PUT", headers: { "content-type": "application/json", "content-length": "100001" }, body: "{}" });
  assert.equal((await f.handlers.save(declared, { projectId: "p1" })).status, 413);
  const streamed = new Request("https://field.test/edit", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ huge: "x".repeat(100001) }) });
  assert.equal((await f.handlers.save(streamed, { projectId: "p1" })).status, 413);
  assert.deepEqual(f.calls, []);
});

test("malformed JSON, invalid UTF8 and misleading content type are rejected", async () => {
  const f = fixture();
  for (const raw of [new Request("https://field.test/edit", { method: "PUT", headers: { "content-type": "application/json" }, body: "{" }), new Request("https://field.test/edit", { method: "PUT", headers: { "content-type": "application/json" }, body: new Uint8Array([255]) }), new Request("https://field.test/edit", { method: "PUT", headers: { "content-type": "application/json-evil" }, body: "{}" })]) {
    assert.equal((await f.handlers.save(raw, { projectId: "p1" })).status, 422);
  }
  assert.deepEqual(f.calls, []);
});

test("CAS and permission failures preserve domain status and hide internal exceptions", async () => {
  const f = fixture(); f.fail(new DomainError("VERSION_CONFLICT", "草稿已更新，当前输入保留。", { status: 409, latestRevision: 4, recoveryAction: "review_latest_edit_draft" }));
  const conflict = await f.handlers.save(request(), { projectId: "p1" }); assert.equal(conflict.status, 409);
  assert.deepEqual((await conflict.json()).error, { code: "VERSION_CONFLICT", message: "草稿已更新，当前输入保留。", latestRevision: 4, recoveryAction: "review_latest_edit_draft" });
  f.fail(new Error("SECRET_DATABASE_PAYLOAD"));
  const failed = await f.handlers.save(request(), { projectId: "p1" }); assert.equal(failed.status, 500); assert.doesNotMatch(await failed.text(), /SECRET_DATABASE_PAYLOAD/);
});

test("account listing accepts only own filters and private deletion carries expected revision", async () => {
  const f = fixture(), listed = await f.handlers.list(request("GET", undefined, "https://field.test/drafts?projectId=old-p&limit=15&afterId=draft-2"));
  assert.equal(listed.status, 200); assert.deepEqual(f.calls.at(-1)?.args, [actor, { projectId: "old-p", limit: 15, afterId: "draft-2" }]);
  assert.equal((await f.handlers.list(request("GET", undefined, "https://field.test/drafts?ownerId=other"))).status, 422);
  const deleted = await f.handlers.delete(request("DELETE", { expectedRevision: 3 }), { id: "draft-1" }); assert.equal(deleted.status, 200); assert.equal((await deleted.json()).data.deleted, true);
  assert.deepEqual(f.calls.at(-1), { name: "delete", args: [actor, "draft-1", 3] });
  assert.equal((await f.handlers.delete(request("DELETE", { expectedRevision: 3, ownerId: "other" }), { id: "draft-1" })).status, 422);
});

test("export is an authenticated private attachment with safe fixed filename", async () => {
  const f = fixture(), response = await f.handlers.exportDraft(request("POST", { format: "markdown" }), { id: "draft-1" });
  assert.equal(response.status, 200); assert.equal(await response.text(), "本人草稿");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="retrospective-edit-draft-1.md"');
  assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.deepEqual(f.calls.at(-1)?.args, [actor, "draft-1", "markdown"]);
  assert.equal((await f.handlers.exportDraft(request("POST", { format: "xml" }), { id: "draft-1" })).status, 422);
  assert.equal((await f.handlers.exportDraft(request("POST", { format: "json", includeProjectSources: true }), { id: "draft-1" })).status, 422);
});
