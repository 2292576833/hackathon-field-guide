import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../../shared/errors.ts";
import type { GeneratedDraft, GenerationInput } from "../domain.ts";
import { generatedDraft, instant, retrospectiveContent, url } from "../validation.ts";
import { alice, bob, charlie, cardContent, content, fixture, hasCode, manualAnswers, ref } from "./fixtures.ts";

test("personal content is private even from platform admin and project manager", async () => {
  const { service } = fixture();
  const doc = await service.createRetrospective(alice, "p1", { scope: "personal", content });
  await assert.rejects(service.getRetrospective(bob, doc.id), hasCode("NOT_FOUND"));
  assert.equal((await service.getRetrospective(alice, doc.id)).document?.content.answers.nextChange, "提前试上传");
  const list = await service.list(bob, { kind: "retrospective", projectId: "p1" });
  assert.equal(list.items.length, 0);
});
test("project conclusions require active project manager, not platform admin alone", async () => {
  const { service, memberships } = fixture();
  const doc = await service.createRetrospective(alice, "p1", { scope: "project", content });
  await assert.rejects(service.confirmRetrospective(alice, doc.id, { expectedRevision: 1 }), hasCode("FORBIDDEN"));
  memberships.set("p1:bob", { ...memberships.get("p1:bob")!, role: "member" });
  await assert.rejects(service.confirmRetrospective(bob, doc.id, { expectedRevision: 1 }), hasCode("FORBIDDEN"));
  memberships.set("p1:bob", { ...memberships.get("p1:bob")!, role: "manager" });
  assert.equal((await service.confirmRetrospective(bob, doc.id, { expectedRevision: 1 })).confirmedBy, "bob");
});
test("former members cannot read shared records; owners can export and delete private notes", async () => {
  const { service, memberships, repository } = fixture();
  const personal = await service.createRetrospective(alice, "p1", { scope: "personal", content: { ...content, evidenceRefs: [] } });
  const shared = await service.createRetrospective(alice, "p1", { scope: "project", content });
  memberships.set("p1:alice", { ...memberships.get("p1:alice")!, status: "left" });
  await assert.rejects(service.getRetrospective(alice, shared.id), hasCode("FORBIDDEN"));
  assert.match((await service.exportDocument(alice, personal.id, "json")).content, /最小演示/);
  await service.deletePersonal(alice, personal.id, 1);
  assert.equal(await repository.getVersion(personal.id, 1), null);
});
test("wrong project, missing version, private shared source and assessment evidence are rejected", async () => {
  const f = fixture();
  f.evidence.set(ref.id, { ...f.evidence.get(ref.id)!, projectId: "other" });
  await assert.rejects(f.service.createRetrospective(alice, "p1", { scope: "project", content }), hasCode("EVIDENCE_UNAVAILABLE"));
  f.evidence.set(ref.id, { ref: { ...ref, revision: 2 }, projectId: "p1", state: "available", projectShareable: true });
  await assert.rejects(f.service.createRetrospective(alice, "p1", { scope: "project", content }), hasCode("EVIDENCE_UNAVAILABLE"));
  f.evidence.set(ref.id, { ref, projectId: "p1", state: "available", projectShareable: false });
  await assert.rejects(f.service.createRetrospective(alice, "p1", { scope: "project", content }), hasCode("EVIDENCE_UNAVAILABLE"));
  assert.throws(() => retrospectiveContent({ ...content, evidenceRefs: [{ ...ref, kind: "assessment" }] }), hasCode("INVALID_INPUT"));
});
test("revoked evidence hides body, generated draft, history, export and reuse", async () => {
  const f = fixture();
  const doc = await f.service.createRetrospective(alice, "p1", { scope: "project", content });
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "project", content: cardContent });
  const confirmed = await f.service.confirmExperienceCard(bob, card.id, 1);
  f.evidence.set(ref.id, { ...f.evidence.get(ref.id)!, state: "withdrawn", title: "PRIVATE_SECRET" });
  const view = await f.service.getRetrospective(bob, doc.id);
  assert.equal(view.document, null); assert.equal(view.needsReview, true);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_SECRET|最小演示/);
  assert.equal((await f.service.historyVersion(bob, doc.id, 1)).document, null);
  await assert.rejects(f.service.exportDocument(bob, doc.id, "json"), hasCode("EVIDENCE_UNAVAILABLE"));
  await assert.rejects(f.service.createReuseDraft(bob, "p2", { sourceCardId: card.id, sourceRevision: confirmed.revision, selectedFields: ["advice"], acknowledgeRechecks: true }), hasCode("RECHECK_REQUIRED"));
  // Sharing withdrawal remains available after evidence revocation.
  const withdrawn = await f.service.updateRetrospective(alice, doc.id, { expectedRevision: 1, scope: "personal" });
  assert.equal(withdrawn.scope, "personal");
  assert.equal(withdrawn.document, null);
  const marked = await f.service.updateExperienceCard(bob, card.id, { expectedRevision: confirmed.revision, status: "outdated" });
  assert.equal(marked.document, null);
  assert.doesNotMatch(JSON.stringify(marked), /提前明确负责人|PRIVATE_SECRET/);
});
test("two writes at the same revision do not overwrite each other", async () => {
  const { service } = fixture();
  const doc = await service.createRetrospective(alice, "p1", { scope: "personal", content });
  const results = await Promise.allSettled([service.updateRetrospective(alice, doc.id, { expectedRevision: 1, content: { ...content, answers: { ...manualAnswers, nextChange: "方案A" } } }), service.updateRetrospective(alice, doc.id, { expectedRevision: 1, content: { ...content, answers: { ...manualAnswers, nextChange: "方案B" } } })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(hasCode("VERSION_CONFLICT")(rejected.reason));
  assert.equal(rejected.reason.latestRevision, 2);
});
test("sharing later never exposes earlier private versions", async () => {
  const { service } = fixture();
  const doc = await service.createRetrospective(alice, "p1", { scope: "personal", content });
  await service.updateRetrospective(alice, doc.id, { expectedRevision: 1, scope: "project", content });
  await assert.rejects(service.historyVersion(bob, doc.id, 1), hasCode("NOT_FOUND"));
  assert.equal((await service.historyVersion(bob, doc.id, 2)).scope, "project");
});
test("reuse copies only selected reference fields and revalidates source sharing", async () => {
  const { service, repository } = fixture();
  const card = await service.createExperienceCard(alice, "p1", { scope: "project", content: cardContent });
  const confirmed = await service.confirmExperienceCard(bob, card.id, 1);
  const draft = await service.createReuseDraft(charlie, "p2", { sourceCardId: card.id, sourceRevision: confirmed.revision, selectedFields: ["advice", "conditions"], acknowledgeRechecks: true });
  assert.deepEqual(Object.keys((await service.getReuseDraft(charlie, draft.id)).selectedContent), ["advice", "conditions"]);
  assert.equal(draft.status, "draft"); assert.equal(draft.scope, "personal");
  assert.doesNotMatch(JSON.stringify(await repository.get(draft.id)), /提前明确负责人|授权|submittedAt|deadline/);
  await assert.rejects(service.createReuseDraft(charlie, "p2", { sourceCardId: card.id, sourceRevision: confirmed.revision, selectedFields: ["deadline"], acknowledgeRechecks: true }), hasCode("INVALID_INPUT"));
  await service.updateExperienceCard(alice, card.id, { expectedRevision: confirmed.revision, scope: "personal" });
  await assert.rejects(service.getReuseDraft(charlie, draft.id), hasCode("NOT_FOUND"));
  await assert.rejects(service.getReuseDraft(bob, draft.id), hasCode("NOT_FOUND"));
});
test("personal source retrospectives require explicit sharing before making a shared card", async () => {
  const { service } = fixture();
  const doc = await service.createRetrospective(alice, "p1", { scope: "personal", content });
  const confirmed = await service.confirmRetrospective(alice, doc.id, { expectedRevision: 1 });
  await assert.rejects(service.createExperienceCard(alice, "p1", { scope: "project", content: cardContent, sourceRetrospective: { id: doc.id, revision: confirmed.revision } }), hasCode("EXPLICIT_SHARE_REQUIRED"));
});
test("model unavailable and timeout retain manual content; queued is not complete", async () => {
  const unavailable = fixture();
  const doc = await unavailable.service.createRetrospective(alice, "p1", { scope: "personal", content });
  await assert.rejects(unavailable.service.enqueueGeneration(alice, doc.id, 1), hasCode("MODEL_UNAVAILABLE"));
  let aborted = false;
  const f = fixture({ modelTimeoutMs: 5, model: { async generate(_input, signal) { signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {}); } } });
  const editable = await f.service.createRetrospective(alice, "p1", { scope: "personal", content });
  const job = await f.service.enqueueGeneration(alice, editable.id, 1); assert.equal(job.status, "queued");
  const finished = await f.service.runGeneration(job.id);
  assert.equal(finished.status, "failed"); assert.equal(finished.errorCode, "MODEL_TIMEOUT"); assert.ok(aborted);
  const saved = (await f.service.getRetrospective(alice, editable.id)).document!;
  assert.equal(saved.status, "draft"); assert.deepEqual(saved.content.answers, manualAnswers);
});
test("model input is allowlisted and generated output requires human confirmation", async () => {
  let input: GenerationInput | undefined;
  const f = fixture({ model: { async generate(value) { input = value; return { answers: { ...manualAnswers, nextChange: "生成建议" }, evidenceRefs: [], resourceIds: [], modelVersion: "test-model" }; } } });
  const doc = await f.service.createRetrospective(alice, "p1", { scope: "project", content });
  const job = await f.service.enqueueGeneration(bob, doc.id, 1);
  assert.equal((await f.service.runGeneration(job.id)).status, "succeeded");
  assert.deepEqual(Object.keys(input!).sort(), ["answers", "evidence", "inputRevision", "promptVersion", "retrospectiveId", "reviewedResourceIds", "scope", "tools"].sort());
  const saved = (await f.service.getRetrospective(bob, doc.id)).document!;
  assert.equal(saved.status, "review_required"); assert.equal(saved.content.answers.nextChange, "提前试上传");
  f.evidence.set(ref.id, { ...f.evidence.get(ref.id)!, state: "withdrawn" });
  await assert.rejects(f.service.confirmRetrospective(bob, doc.id, { expectedRevision: saved.revision, useGeneratedDraft: true }), hasCode("EVIDENCE_UNAVAILABLE"));
});
test("editing during generation preserves the newer human answer", async () => {
  let started!: () => void, finish!: (value: unknown) => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const f = fixture({ model: { generate() { started(); return new Promise(resolve => { finish = resolve; }); } } });
  const doc = await f.service.createRetrospective(alice, "p1", { scope: "personal", content });
  const job = await f.service.enqueueGeneration(alice, doc.id, 1);
  const running = f.service.runGeneration(job.id); await startedPromise;
  await f.service.updateRetrospective(alice, doc.id, { expectedRevision: 2, content: { ...content, answers: { ...manualAnswers, nextChange: "最新人工内容" } } });
  finish({ answers: manualAnswers, evidenceRefs: [ref], resourceIds: [], modelVersion: "test" });
  assert.equal((await running).status, "failed");
  assert.equal((await f.service.getRetrospective(alice, doc.id)).document?.content.answers.nextChange, "最新人工内容");
});
test("membership revoked during model call prevents committing its draft", async () => {
  const f = fixture({ model: { async generate() { f.memberships.set("p1:alice", { ...f.memberships.get("p1:alice")!, status: "removed" }); return { answers: manualAnswers, evidenceRefs: [ref], resourceIds: [], modelVersion: "test" }; } } });
  const doc = await f.service.createRetrospective(alice, "p1", { scope: "project", content });
  const job = await f.service.enqueueGeneration(alice, doc.id, 1);
  const result = await f.service.runGeneration(job.id);
  assert.equal(result.errorCode, "FORBIDDEN");
  assert.equal((await f.repository.get(doc.id))?.status, "draft");
});
test("budget rejection happens before a model call and retains manual draft", async () => {
  let calls = 0;
  const f = fixture({ generationBudget: { async reserve() { throw new DomainError("BUDGET_EXCEEDED", "今天的整理额度已用完。", { status: 429 }); } }, model: { async generate() { calls++; return {}; } } });
  const doc = await f.service.createRetrospective(alice, "p1", { scope: "personal", content });
  const job = await f.service.enqueueGeneration(alice, doc.id, 1);
  assert.equal((await f.service.runGeneration(job.id)).errorCode, "BUDGET_EXCEEDED");
  assert.equal(calls, 0);
  assert.equal((await f.service.getRetrospective(alice, doc.id)).document?.status, "draft");
});
test("queue supervisor can expire a crashed worker without discarding manual content", async () => {
  let time = new Date("2026-10-08T10:00:00Z");
  const f = fixture({ clock: { now() { return time; } }, model: { async generate() { return {}; } } });
  const doc = await f.service.createRetrospective(alice, "p1", { scope: "personal", content });
  const job = await f.service.enqueueGeneration(alice, doc.id, 1);
  f.repository.documents.set(job.id, { ...job, revision: 2, status: "running", attempts: 1 });
  time = new Date("2026-10-08T10:01:00Z");
  assert.equal((await f.service.recoverExpiredGeneration(job.id)).errorCode, "WORKER_EXPIRED");
  const restored = (await f.service.getRetrospective(alice, doc.id)).document!;
  assert.equal(restored.status, "draft"); assert.deepEqual(restored.content.answers, manualAnswers);
});
test("source retrospective change blocks card prose until reselected and confirmed", async () => {
  const f = fixture();
  const doc = await f.service.createRetrospective(alice, "p1", { scope: "project", content });
  const confirmed = await f.service.confirmRetrospective(bob, doc.id, { expectedRevision: 1 });
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "project", content: cardContent, sourceRetrospective: { id: doc.id, revision: confirmed.revision } });
  await f.service.updateRetrospective(alice, doc.id, { expectedRevision: confirmed.revision, content });
  const view = await f.service.getExperienceCard(bob, card.id);
  assert.equal(view.needsReview, true); assert.equal(view.document, null);
  const updated = await f.service.confirmRetrospective(bob, doc.id, { expectedRevision: 3 });
  await f.service.updateExperienceCard(alice, card.id, { expectedRevision: 1, content: cardContent, sourceRetrospective: { id: doc.id, revision: updated.revision } });
  assert.ok((await f.service.getExperienceCard(bob, card.id)).document);
});
test("manager cannot rebase a withdrawn source to reveal the retained old card body", async () => {
  const f = fixture();
  const source = await f.service.createRetrospective(alice, "p1", { scope: "project", content: { ...content, evidenceRefs: [] } });
  const confirmedSource = await f.service.confirmRetrospective(bob, source.id, { expectedRevision: 1 });
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "project", content: { ...cardContent, advice: ["SECRET_FROM_REVOKED_SOURCE"], evidenceRefs: [] }, sourceRetrospective: { id: source.id, revision: confirmedSource.revision } });
  await f.service.updateRetrospective(alice, source.id, { expectedRevision: confirmedSource.revision, scope: "personal" });
  const replacement = await f.service.createRetrospective(bob, "p1", { scope: "project", content: { ...content, evidenceRefs: [] } });
  const confirmedReplacement = await f.service.confirmRetrospective(bob, replacement.id, { expectedRevision: 1 });
  await assert.rejects(f.service.updateExperienceCard(bob, card.id, { expectedRevision: 1, sourceRetrospective: { id: replacement.id, revision: confirmedReplacement.revision } }), hasCode("SOURCE_WITHDRAWN"));
  assert.doesNotMatch(JSON.stringify(await f.service.getExperienceCard(bob, card.id)), /SECRET_FROM_REVOKED_SOURCE/);
});
test("resource takedown propagates through a source retrospective even when the card omits tools", async () => {
  const f = fixture();
  const tool = { resourceId: "resource-1", usedFor: "准备素材", limitations: "费用与许可待核验", costAtUse: "未知", source: "member_record" };
  const source = await f.service.createRetrospective(alice, "p1", { scope: "project", content: { ...content, tools: [tool] } });
  const confirmedSource = await f.service.confirmRetrospective(bob, source.id, { expectedRevision: 1 });
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "project", content: cardContent, sourceRetrospective: { id: source.id, revision: confirmedSource.revision } });
  const confirmed = await f.service.confirmExperienceCard(bob, card.id, 1);
  f.reviewed.clear();
  const view = await f.service.getExperienceCard(bob, card.id);
  assert.equal(view.needsReview, true); assert.equal(view.document, null);
  await assert.rejects(f.service.createReuseDraft(bob, "p2", { sourceCardId: card.id, sourceRevision: confirmed.revision, selectedFields: ["advice"], acknowledgeRechecks: true }), hasCode("RESOURCE_UNREVIEWED"));
});
test("card owner cannot rebase another author's withdrawn source without rewriting body", async () => {
  const f = fixture();
  const source = await f.service.createRetrospective(bob, "p1", { scope: "project", content: { ...content, evidenceRefs: [] } });
  const confirmed = await f.service.confirmRetrospective(bob, source.id, { expectedRevision: 1 });
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "project", content: { ...cardContent, advice: ["WITHDRAWN_SOURCE_BODY"], evidenceRefs: [] }, sourceRetrospective: { id: source.id, revision: confirmed.revision } });
  await f.service.updateRetrospective(bob, source.id, { expectedRevision: confirmed.revision, scope: "personal" });
  const other = await f.service.createRetrospective(bob, "p1", { scope: "project", content: { ...content, evidenceRefs: [] } });
  const confirmedOther = await f.service.confirmRetrospective(bob, other.id, { expectedRevision: 1 });
  await assert.rejects(f.service.updateExperienceCard(alice, card.id, { expectedRevision: 1, sourceRetrospective: { id: other.id, revision: confirmedOther.revision } }), hasCode("SOURCE_WITHDRAWN"));
  assert.doesNotMatch(JSON.stringify(await f.service.getExperienceCard(alice, card.id)), /WITHDRAWN_SOURCE_BODY/);
});
test("model fabricated refs, raw URLs, account fields and unreviewed resources are rejected", () => {
  const generated: GeneratedDraft = { answers: manualAnswers, evidenceRefs: [ref], resourceIds: [], modelVersion: "test", promptVersion: "m07-v1" };
  const { promptVersion: _prompt, ...output } = generated;
  assert.throws(() => generatedDraft({ ...output, evidenceRefs: [{ ...ref, id: "fake" }] }, [ref], []), hasCode("INVALID_INPUT"));
  assert.throws(() => generatedDraft({ ...output, resourceIds: ["fake"] }, [ref], []), hasCode("INVALID_INPUT"));
  assert.throws(() => generatedDraft({ ...output, answers: { ...manualAnswers, nextChange: "请使用https://invented.invalid" } }, [ref], []), hasCode("INVALID_INPUT"));
  assert.throws(() => retrospectiveContent({ ...content, accessToken: "secret" }), hasCode("INVALID_INPUT"));
  assert.throws(() => instant("2026-02-30T12:00:00+08:00"), hasCode("INVALID_INPUT"));
  assert.throws(() => url("https://tool.example/#access_token=SHOULD_NOT_BE_SAVED"), hasCode("INVALID_INPUT"));
  assert.throws(() => url("https://tool.example/#/callback?api_key=SHOULD_NOT_BE_SAVED"), hasCode("INVALID_INPUT"));
});
test("tool records keep cost and license uncertainty and reviewed ID is checked again on reuse", async () => {
  const f = fixture();
  const tool = { resourceId: "resource-1", usedFor: "整理演示", limitations: "许可与比赛使用范围待核验", costAtUse: "未知", source: "member_record" };
  const card = await f.service.createExperienceCard(alice, "p1", { scope: "personal", content: { ...cardContent, tools: [tool] } });
  const confirmed = await f.service.confirmExperienceCard(alice, card.id, 1);
  f.reviewed.clear();
  assert.equal((await f.service.getExperienceCard(alice, card.id)).needsReview, true);
  await assert.rejects(f.service.createReuseDraft(alice, "p2", { sourceCardId: card.id, sourceRevision: confirmed.revision, selectedFields: ["tools"], acknowledgeRechecks: true }), hasCode("RECHECK_REQUIRED"));
});
test("archived projects allow reading/export, disallow mutations", async () => {
  const f = fixture();
  const doc = await f.service.createRetrospective(alice, "p1", { scope: "personal", content });
  f.archived.add("p1");
  assert.ok((await f.service.getRetrospective(alice, doc.id)).document);
  assert.match((await f.service.exportDocument(alice, doc.id, "markdown")).content, /复盘/);
  await assert.rejects(f.service.updateRetrospective(alice, doc.id, { expectedRevision: 1, content }), hasCode("PROJECT_ARCHIVED"));
});
test("delivery save success does not become run or platform submission success", async () => {
  const f = fixture({ delivery: { async read() { return { saves: [{ id: "save-1", projectId: "p1", revision: 1, status: "saved", repositoryUrl: "https://github.com/example/repo", branch: "entry", commitSha: "abc", recordedAt: "2026-10-08T00:00:00Z" }], verifications: [], submissions: [], materials: [] }; } } });
  const summary = await f.service.deliverySummary(alice, "p1") as { execution: { label: string }; submission: { label: string } };
  assert.equal(summary.execution.label, "未记录"); assert.equal(summary.submission.label, "未记录");
  f.dependencies.delivery = { async read() { return { saves: [], verifications: [], submissions: [{ id: "sub-1", projectId: "p1", eventId: "e1", stageId: "video", requirementsVersion: "rules-v1", platformUrl: "https://example.com/project", submittedAt: "2026-10-08T00:00:00Z", status: "reported", verificationSource: "user_reported", evidenceRefs: [], repositoryCommitSha: null, recordedAt: "2026-10-08T00:00:00Z", recordedBy: "alice", version: 1 }], materials: [] }; } };
  assert.match(JSON.stringify(await f.service.deliverySummary(alice, "p1")), /队员记录/);
});
