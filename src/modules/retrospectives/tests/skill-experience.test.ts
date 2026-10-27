import test from "node:test";
import assert from "node:assert/strict";
import { fixture, alice, cardContent, content, hasCode } from "./fixtures.ts";
import type { SkillUsage } from "../skill-usage.ts";
import { validateEditDraftContent } from "../edit-drafts.ts";
import { retrospectiveContent } from "../validation.ts";

const usage: SkillUsage = { reference: { kind: "skill", id: "demo-guide", version: "1.2.0", versionId: "demo-guide@1.2.0", contentHash: "a".repeat(64), revision: 2 }, purpose: "准备演示说明", feedback: "我试过一次，帮助列清演示步骤", limitations: "未验证其他客户端，学习时间与许可需重新核验" };

test("optional skill feedback preserves old records and incomplete private input without creating verification fields", () => {
  assert.deepEqual(retrospectiveContent(content), content);
  const incomplete = { ...content, skillUsage: [{ ...usage, feedback: " \n", limitations: "" }] };
  assert.deepEqual(validateEditDraftContent(incomplete).skillUsage, incomplete.skillUsage);
  assert.throws(() => retrospectiveContent(incomplete), hasCode("INVALID_INPUT"));
});

test("owner historical skill text and exact references survive leaving and export without an M10 lookup", async () => {
  const f = fixture();
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "personal", content: { ...cardContent, evidenceRefs: [], skillUsage: [usage] } });
  f.memberships.delete("p1:alice");
  const historical = await f.service.historyVersion(alice, card.id, 1);
  assert.equal(historical.document?.kind, "experience_card");
  assert.deepEqual(historical.document?.kind === "experience_card" && historical.document.content.skillUsage, [usage]);
  for (const format of ["json", "markdown"] as const) {
    const file = await f.service.exportDocument(alice, card.id, format);
    assert.match(file.content, /帮助列清演示步骤/); assert.match(file.content, /demo-guide/); assert.match(file.content, /1\.2\.0/);
    assert.ok(file.content.includes(usage.reference.contentHash));
    assert.doesNotMatch(file.content, /installationReceipt|platform_verified|taskEvaluation/);
  }
});

test("explicit reuse copies skill metadata and member text only, preserves target permissions and demands rechecks", async () => {
  const f = fixture();
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "personal", content: { ...cardContent, evidenceRefs: [], skillUsage: [usage] } });
  const confirmed = await f.service.confirmExperienceCard(alice, card.id, 1);
  const draft = await f.service.createReuseDraft(alice, "p2", { sourceCardId: card.id, sourceRevision: confirmed.revision, selectedFields: ["skillUsage"], acknowledgeRechecks: true });
  const preview = await f.service.getReuseDraft(alice, draft.id);
  assert.deepEqual(preview.selectedContent, { skillUsage: [usage] });
  assert.match(preview.requiredRechecks.join("\n"), /精确版本/);
  assert.match(preview.requiredRechecks.join("\n"), /安装或兼容性证明/);
  const saved = await f.repository.get(draft.id);
  assert.equal(saved?.kind, "reuse_draft"); assert.ok(!("skillUsage" in saved!));
  assert.deepEqual(f.repository.events.map(event => event.type), ["DocumentEdited", "ExperienceCardConfirmed", "ExperienceReused"]);
  f.memberships.delete("p2:alice");
  assert.equal((await f.service.getPersonalReuseDraft(alice, draft.id)).selectedContent, null);
  await assert.rejects(f.service.createReuseDraft(alice, "p2", { sourceCardId: card.id, sourceRevision: confirmed.revision, selectedFields: ["skillUsage"], acknowledgeRechecks: true }), hasCode("FORBIDDEN"));
});

test("old experience remains reusable and cannot pretend to have a new skill usage field", async () => {
  const f = fixture();
  const old = await f.service.createExperienceCard(alice, "p1", { scope: "personal", content: { ...cardContent, evidenceRefs: [] } });
  const confirmed = await f.service.confirmExperienceCard(alice, old.id, 1);
  await assert.rejects(f.service.createReuseDraft(alice, "p2", { sourceCardId: old.id, sourceRevision: confirmed.revision, selectedFields: ["skillUsage"], acknowledgeRechecks: true }), hasCode("INVALID_INPUT"));
  const draft = await f.service.createReuseDraft(alice, "p2", { sourceCardId: old.id, sourceRevision: confirmed.revision, selectedFields: ["advice"], acknowledgeRechecks: true });
  assert.deepEqual((await f.service.getReuseDraft(alice, draft.id)).selectedContent, { advice: cardContent.advice });
});

test("skill feedback export redacts recognizable credentials while preserving historical member input", async () => {
  const f = fixture();
  const reported = { ...usage, feedback: "API_KEY=private-secret 用于本人的一次尝试" };
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "personal", content: { ...cardContent, evidenceRefs: [], skillUsage: [reported] } });
  for (const format of ["json", "markdown"] as const) assert.doesNotMatch((await f.service.exportDocument(alice, card.id, format)).content, /private-secret/);
  assert.equal((await f.service.getExperienceCard(alice, card.id)).document!.content.skillUsage![0].feedback, reported.feedback);
});
