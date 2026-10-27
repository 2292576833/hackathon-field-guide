import test from "node:test";
import assert from "node:assert/strict";
import { fixture, alice, bob, cardContent, content, hasCode } from "./fixtures.ts";
import { createRetrospectiveHandlers } from "../handlers.ts";

test("account filters retain own private records after leaving without opening team sources", async () => {
  let reads = 0;
  const f = fixture({ evidence: { async resolve() { reads++; throw new Error("must not read team facts"); } } });
  const own = await f.service.createExperienceCard(alice, "p1", { scope: "personal", content: { ...cardContent, evidenceRefs: [] } });
  await f.service.createExperienceCard(bob, "p1", { scope: "personal", content: { ...cardContent, evidenceRefs: [] } });
  await f.service.createExperienceCard(bob, "p1", { scope: "project", content: { ...cardContent, evidenceRefs: [] } });
  f.memberships.delete("p1:alice");
  const page = await f.service.listPersonalRecords(alice, "experience_card", { projectId: "p1", query: "素材" });
  assert.deepEqual(page.items.map(item => item.id), [own.id]);
  assert.equal(page.items[0].document?.ownerId, alice.userId);
  assert.equal(reads, 0);
  const exported = await f.service.exportDocument(alice, own.id, "json");
  assert.match(exported.content, /提前准备素材/);
  await assert.rejects(f.service.getExperienceCard(bob, own.id), hasCode("NOT_FOUND"));
  await f.service.deletePersonal(alice, own.id, own.revision);
  assert.equal(await f.repository.get(own.id), null);
});

test("revoked membership cannot resolve evidence through an owner account page or search hidden text", async () => {
  const f = fixture();
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "personal", content: cardContent });
  let reads = 0; f.dependencies.evidence = { async resolve() { reads++; throw new Error("private project source read"); } };
  f.memberships.delete("p1:alice");
  const result = await f.service.listPersonalRecords(alice, "experience_card", { projectId: "p1" });
  assert.equal(result.items[0].document, null);
  assert.equal(result.items[0].needsReview, true);
  assert.equal(reads, 0);
  assert.equal((await f.service.listPersonalRecords(alice, "experience_card", { query: "素材" })).items.length, 0);
  await assert.rejects(f.service.exportDocument(alice, card.id, "json"), hasCode("EVIDENCE_UNAVAILABLE"));
  await f.service.deletePersonal(alice, card.id, card.revision);
});

test("owner can find and delete persisted reuse selection after target access was removed", async () => {
  const f = fixture();
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "personal", content: { ...cardContent, evidenceRefs: [] } });
  const confirmed = await f.service.confirmExperienceCard(alice, card.id, card.revision);
  const draft = await f.service.createReuseDraft(alice, "p2", { sourceCardId: confirmed.id, sourceRevision: confirmed.revision, selectedFields: ["advice", "conditions"], acknowledgeRechecks: true });
  f.memberships.delete("p2:alice");
  let sourceReads = 0; const originalGet = f.repository.get.bind(f.repository);
  f.repository.get = async id => { if (id === card.id) sourceReads++; return originalGet(id); };
  const page = await f.service.listReuseDrafts(alice);
  assert.equal(page.items.length, 1); assert.equal(page.items[0].draft.id, draft.id);
  assert.equal(page.items[0].selectedContent, null); assert.match(page.items[0].unavailableReason!, /权限或来源/);
  assert.equal(sourceReads, 0);
  assert.deepEqual((await f.service.listReuseDrafts(bob)).items, []);
  await assert.rejects(f.service.getPersonalReuseDraft(bob, draft.id), hasCode("NOT_FOUND"));
  await f.service.deletePersonal(alice, draft.id, draft.revision);
  assert.equal(await f.repository.get(draft.id), null);
});

test("permission removed while evidence resolves hides account body before returning", async () => {
  const f = fixture();
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "personal", content: cardContent });
  f.dependencies.evidence = { async resolve() { const old = structuredClone([...f.evidence.values()]); f.memberships.delete("p1:alice"); return old; } };
  const view = await f.service.getExperienceCard(alice, card.id);
  assert.equal(view.document, null); assert.equal(view.evidenceStates[0].state, "unavailable");
});

for (const path of ["get", "history", "export", "list"] as const) test(`shared source revoked while private card resources resolve cannot escape through ${path}`, async () => {
  const f = fixture();
  const source = await f.service.createRetrospective(bob, "p1", { scope: "project", content: { ...content, evidenceRefs: [], tools: [] } });
  const confirmed = await f.service.confirmRetrospective(bob, source.id, { expectedRevision: source.revision });
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "personal", sourceRetrospective: { id: confirmed.id, revision: confirmed.revision }, content: { ...cardContent, evidenceRefs: [], tools: [{ resourceId: "resource-1", usedFor: "准备材料", limitations: "待核验", costAtUse: "未知", source: "member_record" }] } });
  f.dependencies.resources = { async isReviewed() { f.memberships.delete("p1:alice"); return true; } };
  if (path === "export") await assert.rejects(f.service.exportDocument(alice, card.id, "json"), hasCode("FORBIDDEN"));
  else if (path === "history") assert.equal((await f.service.historyVersion(alice, card.id, 1)).document, null);
  else if (path === "list") assert.equal((await f.service.listPersonalRecords(alice, "experience_card")).items[0].document, null);
  else assert.equal((await f.service.getExperienceCard(alice, card.id)).document, null);
});

for (const path of ["get", "history", "export", "list"] as const) test(`evidence withdrawn while resources resolve is freshly filtered through ${path}`, async () => {
  const f = fixture();
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "personal", content: { ...cardContent, tools: [{ resourceId: "resource-1", usedFor: "准备材料", limitations: "待核验", costAtUse: "未知", source: "member_record" }] } });
  f.dependencies.resources = { async isReviewed() { f.evidence.get("task-1")!.state = "withdrawn"; return true; } };
  if (path === "export") await assert.rejects(f.service.exportDocument(alice, card.id, "json"), hasCode("EVIDENCE_UNAVAILABLE"));
  else {
    const result = path === "get" ? await f.service.getExperienceCard(alice, card.id) : path === "history" ? await f.service.historyVersion(alice, card.id, 1) : (await f.service.listPersonalRecords(alice, "experience_card")).items[0];
    assert.equal(result.document, null); assert.equal(result.evidenceStates[0].state, "withdrawn");
  }
});

test("history keeps private scopes private and never restores withdrawn evidence", async () => {
  const f = fixture();
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "personal", content: cardContent });
  await f.service.updateExperienceCard(alice, card.id, { expectedRevision: card.revision, scope: "project" });
  await assert.rejects(f.service.historyVersion(bob, card.id, 1), hasCode("NOT_FOUND"));
  f.evidence.get("task-1")!.state = "withdrawn";
  assert.equal((await f.service.historyVersion(alice, card.id, 1)).document, null);
});

test("history rechecks the current sharing pointer after a withdrawal during version loading", async () => {
  const f = fixture();
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "project", content: { ...cardContent, evidenceRefs: [] } });
  const original = f.repository.getVersion.bind(f.repository);
  f.repository.getVersion = async (id, version) => {
    const result = await original(id, version);
    await f.service.updateExperienceCard(alice, card.id, { expectedRevision: card.revision, scope: "personal" });
    return result;
  };
  await assert.rejects(f.service.historyVersion(bob, card.id, 1), hasCode("NOT_FOUND"));
});

test("current record rechecks sharing after resource resolution awaits", async () => {
  const f = fixture();
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "project", content: { ...cardContent, evidenceRefs: [], tools: [{ resourceId: "resource-1", usedFor: "材料", limitations: "未知", costAtUse: "未知", source: "member_record" }] } });
  let withdrawn = false;
  f.dependencies.resources = { async isReviewed() { if (!withdrawn) { withdrawn = true; await f.service.updateExperienceCard(alice, card.id, { expectedRevision: card.revision, scope: "personal" }); } return true; } };
  await assert.rejects(f.service.getExperienceCard(bob, card.id), hasCode("NOT_FOUND"));
});

test("JSON and Markdown export whitelist and redact recognizable credentials without changing originals", async () => {
  const f = fixture();
  const manual = { ...content, evidenceRefs: [], answers: { ...content.answers, nextChange: "API_KEY=super-secret Bearer abcdefghijk alice@example.com 13812345678" } };
  const doc = await f.service.createRetrospective(alice, "p1", { scope: "personal", content: manual });
  for (const format of ["json", "markdown"] as const) {
    const file = await f.service.exportDocument(alice, doc.id, format);
    assert.doesNotMatch(file.content, /super-secret|abcdefghijk|alice@example\.com|13812345678|ownerId|platformRoles|generatedDraft|inputSnapshot/);
    assert.match(file.content, /凭据已省略/);
  }
  assert.equal((await f.service.getRetrospective(alice, doc.id)).document!.content.answers.nextChange, manual.answers.nextChange);
});

test("personal HTTP list is session-owned, validates filters and supports left-project filtering", async () => {
  const f = fixture();
  const doc = await f.service.createExperienceCard(alice, "p1", { scope: "personal", content: { ...cardContent, evidenceRefs: [] } });
  f.memberships.delete("p1:alice");
  const handlers = createRetrospectiveHandlers({ service: f.service, authenticate: async () => alice, requestId: () => "req" });
  const response = await handlers.listPersonalExperienceCards(new Request("https://site.test/api/v1/experience-cards?projectId=p1&query=素材"), {});
  assert.equal(response.status, 200); assert.equal((await response.json()).data.items[0].id, doc.id);
  const spoofed = await handlers.listPersonalExperienceCards(new Request("https://site.test/api/v1/experience-cards?ownerId=bob"), {});
  assert.equal(spoofed.status, 422);
  const invalid = await handlers.listPersonalExperienceCards(new Request("https://site.test/api/v1/experience-cards?status=fake"), {});
  assert.equal(invalid.status, 422);
});

test("account text filtering scans beyond the first page and paginates matching authorized fields", async () => {
  const f = fixture();
  for (let index = 0; index < 25; index++) await f.service.createExperienceCard(alice, "p1", { scope: "personal", content: { ...cardContent, title: index >= 23 ? "上传材料" : "视频素材", evidenceRefs: [] } });
  const first = await f.service.listPersonalRecords(alice, "experience_card", { query: "上传材料", limit: 1 });
  assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
  const second = await f.service.listPersonalRecords(alice, "experience_card", { query: "上传材料", limit: 1, afterId: first.nextCursor! });
  assert.equal(second.items.length, 1); assert.notEqual(first.items[0].id, second.items[0].id); assert.equal(second.nextCursor, null);
});
